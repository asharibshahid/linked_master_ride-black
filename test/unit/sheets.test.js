const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateSheetsConfig } = require("../../src/sheets/sheetsClient");
const {
  verifyWorksheetTargetsReady,
  ensureWorksheetWithHeaders,
  ensureRideInstructionHeader,
  applyFinalBidAssignedDriverValidation,
  applyTextFormatForHeaders
} = require("../../src/app");
const {
  classifyAppendFailure,
  buildAppendRange,
  buildSheetRow,
  fetchSheetHeaders
} = require("../../src/sheets/appendRow");
const {
  buildSheetRowObject,
  cleanDropOffForSheet
} = require("../../src/extraction/schemas");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ride-bot-sheets-test-"));
}

function writeFile(filePath, content) {
  fs.writeFileSync(filePath, content, "utf8");
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

test("validateSheetsConfig catches missing required values", () => {
  const result = validateSheetsConfig({
    spreadsheetId: "",
    worksheetName: "",
    range: "",
    credentialsPath: ""
  });

  assert.equal(result.valid, false);
  assert.ok(result.missing.includes("GOOGLE_SHEETS_ID"));
  assert.ok(result.missing.includes("GOOGLE_CREDENTIALS_JSON or GOOGLE_APPLICATION_CREDENTIALS"));
});

test("validateSheetsConfig detects invalid JSON credentials file", () => {
  const tempDir = makeTempDir();
  const credentialsPath = path.join(tempDir, "credentials.json");
  writeFile(credentialsPath, "{not json}");

  const result = validateSheetsConfig({
    spreadsheetId: "sheet-id",
    worksheetName: "Sheet1",
    credentialsPath
  });

  assert.equal(result.valid, false);
  assert.equal(result.credentialsStatus.code, "GOOGLE_CREDENTIALS_JSON_INVALID");

  cleanup(tempDir);
});

test("validateSheetsConfig accepts service account JSON directly from env-style input", () => {
  const result = validateSheetsConfig({
    spreadsheetId: "sheet-id",
    worksheetName: "Sheet1",
    credentialsJson: {
      type: "service_account",
      client_email: "bot@example.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n"
    }
  });

  assert.equal(result.valid, true);
  assert.equal(result.credentialsStatus.code, "GOOGLE_CREDENTIALS_READY");
  assert.equal(result.credentialsStatus.source, "env_json");
});

test("validateSheetsConfig detects missing required fields in credentials file", () => {
  const tempDir = makeTempDir();
  const credentialsPath = path.join(tempDir, "credentials.json");
  writeFile(credentialsPath, JSON.stringify({ type: "service_account" }));

  const result = validateSheetsConfig({
    spreadsheetId: "sheet-id",
    worksheetName: "Sheet1",
    credentialsPath
  });

  assert.equal(result.valid, false);
  assert.equal(result.credentialsStatus.code, "GOOGLE_CREDENTIALS_FIELDS_MISSING");

  cleanup(tempDir);
});

test("buildAppendRange uses quoted worksheet names safely", () => {
  const range = buildAppendRange({
    range: "",
    worksheetName: "Ride Sheet"
  });

  assert.equal(range, "'Ride Sheet'");
});

test("buildSheetRow maps strict schema in exact order", () => {
  const row = buildSheetRow({
    refer: "RID-20260415-AB12",
    group_name: "Dispatch Group",
    source_name: "447700900123",
    source_time: "10:15:00 am",
    pickup_day_date: "Tuesday 7th October 2025",
    starting_timing: "20:05 pm",
    pickup: "Heathrow Airport, Terminal 4",
    drop_off: "12 Woodlands Close",
    distance: "10",
    fare: "1200.00",
    required_vehicle: "Estate",
    payment_status: "cash"
  });

  assert.deepEqual(row, [
    "RID-20260415-AB12",
    "Dispatch Group",
    "447700900123",
    "10:15:00 am",
    "Tuesday 7th October 2025",
    "20:05 pm",
    "Heathrow Airport, Terminal 4",
    "12 Woodlands Close",
    "10",
    "1200.00",
    "Estate",
    "cash",
    ""
  ]);
});

test("buildSheetRow maps values by fetched header names instead of fixed positions", () => {
  const row = buildSheetRow(
    {
      refer: "RID-20260415-AB12",
      group_name: "Dispatch Group",
      source_name: "447700900123",
      source_time: "10:15:00 am",
      pickup_day_date: "Tuesday 7th October 2025",
      starting_timing: "20:05 pm",
      pickup: "Heathrow Airport, Terminal 4",
      drop_off: "12 Woodlands Close",
      distance: "10",
      fare: "1200.00",
      required_vehicle: "Estate",
      payment_status: "cash"
    },
    [
      "Pickup",
      "Refer",
      "Source Time",
      "Distance",
      "Required Vehicle",
      "Source Name",
      "Payment Status"
    ]
  );

  assert.deepEqual(row, [
    "Heathrow Airport, Terminal 4",
    "RID-20260415-AB12",
    "10:15:00 am",
    "10",
    "Estate",
    "447700900123",
    "cash"
  ]);
});

test("buildSheetRow keeps blank strings for missing strict fields", () => {
  const row = buildSheetRow({
    refer: "RID-20260415-AB12",
    pickup: "STN"
  });

  assert.equal(row.length, 13);
  assert.equal(row[0], "RID-20260415-AB12");
  assert.equal(row[6], "STN");
  assert.equal(row[11], "");
  assert.equal(row[12], "");
});

test("buildSheetRowObject maps exact sheet headers to ride fields and aliases", () => {
  const rowObject = buildSheetRowObject({
    refer: "RID-20260415-AB12",
    group_name: "testing",
    source_name: "Hafiz Ashari",
    source_time: "09:30:45 am",
    pickup_date: "Tuesday 7th October 2025",
    pickup_time: "20:05 pm",
    pickup: "Heathrow Airport",
    drop_off: "12, Woodlands Close",
    distance: "98",
    fare: "2500.00",
    vehicle: "Saloon Car",
    payment_status: "cash"
  });

  assert.deepEqual(rowObject, {
    Refer: "RID-20260415-AB12",
    "Group Name": "testing",
    "Source Name": "Hafiz Ashari",
    "Source Time": "09:30:45 am",
    "Pickup Day & Date": "Tuesday 7th October 2025",
    "Starting Timing": "20:05 pm",
    Pickup: "Heathrow Airport",
    "Drop Off": "12, Woodlands Close",
    Distance: "98",
    Fare: "2500.00",
    "Required Vehicle": "Saloon Car",
    "Payment Status": "cash",
    "Special Instructions": ""
  });
});

test("cleanDropOffForSheet removes vehicle noise from drop address", () => {
  assert.equal(
    cleanDropOffForSheet("12, Woodlands Close\nSaloon Car", {
      required_vehicle: "Saloon Car"
    }),
    "12, Woodlands Close"
  );

  assert.equal(
    cleanDropOffForSheet("12, Woodlands Close - Saloon Car", {
      required_vehicle: "Saloon Car"
    }),
    "12, Woodlands Close"
  );
});

test("fetchSheetHeaders returns sanitized live headers", async () => {
  const headers = await fetchSheetHeaders({
    sheetsClient: {
      spreadsheets: {
        values: {
          get: async () => ({
            data: {
              values: [[
                "Refer",
                "Group Name",
                "Source Name",
                "Source Time",
                "Pickup Day & Date",
                "Starting Timing",
                "Pickup",
                "Drop Off",
                "Distance",
                "Fare",
                "Required Vehicle",
                "Payment Status"
              ]]
            }
          })
        }
      }
    },
    spreadsheetId: "sheet-id",
    worksheetName: "Rides",
    maxAttempts: 1,
    retryDelayMs: 1,
    logger: { warn: () => {} }
  });

  assert.deepEqual(headers, [
    "Refer",
    "Group Name",
    "Source Name",
    "Source Time",
    "Pickup Day & Date",
    "Starting Timing",
    "Pickup",
    "Drop Off",
    "Distance",
    "Fare",
    "Required Vehicle",
    "Payment Status"
  ]);
});

test("verifyWorksheetTargetsReady accepts rides, review, and upcoming sheets with exact strict headers", async () => {
  const sheetsClient = {
    spreadsheets: {
      get: async () => ({
        data: {
          sheets: [
            { properties: { title: "Rides" } },
            { properties: { title: "Needs Review" } },
            { properties: { title: "Upcoming Jobs >79" } }
          ]
        }
      }),
      values: {
        get: async () => ({
          data: {
            values: [[
              "Refer",
              "Group Name",
              "Source Name",
              "Source Time",
              "Pickup Day & Date",
              "Starting Timing",
              "Pickup",
              "Drop Off",
              "Distance",
              "Fare",
              "Required Vehicle",
              "Payment Status"
            ]]
          }
        })
      }
    }
  };

  await verifyWorksheetTargetsReady({
    sheetsClient,
    spreadsheetId: "sheet-id",
    worksheetTargets: [
      {
        worksheetName: "Rides",
        expectedHeaders: [
          "Refer",
          "Group Name",
          "Source Name",
          "Source Time",
          "Pickup Day & Date",
          "Starting Timing",
          "Pickup",
          "Drop Off",
          "Distance",
          "Fare",
          "Required Vehicle",
          "Payment Status"
        ]
      },
      {
        worksheetName: "Needs Review",
        expectedHeaders: [
          "Refer",
          "Group Name",
          "Source Name",
          "Source Time",
          "Pickup Day & Date",
          "Starting Timing",
          "Pickup",
          "Drop Off",
          "Distance",
          "Fare",
          "Required Vehicle",
          "Payment Status"
        ]
      },
      {
        worksheetName: "Upcoming Jobs >79",
        expectedHeaders: [
          "Refer",
          "Group Name",
          "Source Name",
          "Source Time",
          "Pickup Day & Date",
          "Starting Timing",
          "Pickup",
          "Drop Off",
          "Distance",
          "Fare",
          "Required Vehicle",
          "Payment Status"
        ]
      }
    ],
    logger: { info: () => {}, debug: () => {} }
  });
});

test("ride sheet header upgrade adds only the new trailing column", async () => {
  const calls = [];
  const oldHeaders = [
    "Refer", "Group Name", "Source Name", "Source Time", "Pickup Day & Date",
    "Starting Timing", "Pickup", "Drop Off", "Distance", "Fare",
    "Required Vehicle", "Payment Status"
  ];
  await ensureRideInstructionHeader({
    sheetsClient: {
      spreadsheets: {
        values: {
          get: async () => ({ data: { values: [oldHeaders] } }),
          update: async (request) => { calls.push(request); return { data: {} }; }
        }
      }
    },
    spreadsheetId: "sheet-id",
    worksheetName: "Rides",
    logger: { info() {}, warn() {}, debug() {} }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].range, "'Rides'!M1");
  assert.deepEqual(calls[0].requestBody.values, [["Special Instructions"]]);
});

test("ensureWorksheetWithHeaders creates missing Final Bid worksheet and initializes headers", async () => {
  const calls = [];
  let titles = ["Rides"];
  let headerValues = [];
  const finalBidHeaders = [
    "Refer",
    "Group Name",
    "Source Name",
    "Pickup Day & Date",
    "Starting Timing",
    "Pickup",
    "Drop Off",
    "Distance",
    "Fare",
    "Required Vehicle",
    "Bid Score",
    "Reason",
    "Status",
    "Assigned Driver",
    "Calendar Status",
    "Calendar Event ID",
    "Created Time"
  ];
  const sheetsClient = {
    spreadsheets: {
      get: async () => ({
        data: {
          sheets: titles.map((title) => ({ properties: { title } }))
        }
      }),
      batchUpdate: async (request) => {
        calls.push({ type: "batchUpdate", request });
        titles.push("Final Bid");
        return {};
      },
      values: {
        get: async () => ({
          data: {
            values: headerValues.length > 0 ? [headerValues] : []
          }
        }),
        update: async (request) => {
          calls.push({ type: "values.update", request });
          headerValues = request.requestBody.values[0];
          return {};
        }
      }
    }
  };

  await ensureWorksheetWithHeaders({
    sheetsClient,
    spreadsheetId: "sheet-id",
    worksheetName: "Final Bid",
    headers: finalBidHeaders,
    logger: { info: () => {} }
  });

  assert.deepEqual(
    calls.map((call) => call.type),
    ["batchUpdate", "values.update"]
  );
  assert.deepEqual(headerValues, finalBidHeaders);
});

test("ensureWorksheetWithHeaders skips startup setup instead of crashing on Sheets quota exhaustion", async () => {
  let getCalls = 0;
  const warningMessages = [];
  const quotaError = new Error(
    "Quota exceeded for quota metric 'Read requests' and limit 'Read requests per minute per user'"
  );
  quotaError.response = {
    status: 429,
    data: {
      error: {
        message: quotaError.message
      }
    }
  };

  const sheetsClient = {
    spreadsheets: {
      get: async () => {
        getCalls += 1;
        throw quotaError;
      },
      batchUpdate: async () => {
        throw new Error("should not create sheet when quota is exhausted");
      },
      values: {
        get: async () => {
          throw new Error("should not read headers when quota is exhausted");
        },
        update: async () => {
          throw new Error("should not update headers when quota is exhausted");
        }
      }
    }
  };

  await ensureWorksheetWithHeaders({
    sheetsClient,
    spreadsheetId: "sheet-id",
    worksheetName: "Final Bid",
    headers: ["Refer"],
    logger: {
      info: () => {},
      debug: () => {},
      warn: (message) => warningMessages.push(message)
    }
  });

  assert.equal(getCalls, 4);
  assert.ok(
    warningMessages.includes(
      "Google Sheets worksheet setup skipped because quota is temporarily exhausted"
    )
  );
});

test("applyFinalBidAssignedDriverValidation points Assigned Driver to Drivers IDs", async () => {
  const batchUpdateCalls = [];
  const finalBidHeaders = [
    "Refer",
    "Group Name",
    "Source Name",
    "Pickup Day & Date",
    "Starting Timing",
    "Pickup",
    "Drop Off",
    "Distance",
    "Fare",
    "Required Vehicle",
    "Bid Score",
    "Reason",
    "Status",
    "Assigned Driver",
    "Calendar Status",
    "Calendar Event ID",
    "Created Time"
  ];
  const sheetsClient = {
    spreadsheets: {
      get: async () => ({
        data: {
          sheets: [
            { properties: { title: "Final Bid", sheetId: 10 } },
            { properties: { title: "Drivers", sheetId: 11 } }
          ]
        }
      }),
      values: {
        get: async () => ({
          data: {
            values: [finalBidHeaders]
          }
        })
      },
      batchUpdate: async (request) => {
        batchUpdateCalls.push(request);
        return {};
      }
    }
  };

  await applyFinalBidAssignedDriverValidation({
    sheetsClient,
    spreadsheetId: "sheet-id",
    finalBidWorksheetName: "Final Bid",
    driversWorksheetName: "Drivers",
    logger: { info: () => {}, debug: () => {} }
  });

  assert.equal(batchUpdateCalls.length, 1);
  const validation = batchUpdateCalls[0].requestBody.requests[0].setDataValidation;
  assert.equal(validation.range.sheetId, 10);
  assert.equal(validation.range.startRowIndex, 1);
  assert.equal(validation.range.startColumnIndex, 13);
  assert.equal(validation.range.endColumnIndex, 14);
  assert.equal(validation.rule.condition.type, "ONE_OF_RANGE");
  assert.equal(validation.rule.condition.values[0].userEnteredValue, "=Drivers!$A$2:$A");
  assert.equal(validation.rule.showCustomUi, true);
});

test("applyTextFormatForHeaders formats configured sheet columns as plain text", async () => {
  const batchUpdateCalls = [];
  const sheetsClient = {
    spreadsheets: {
      get: async () => ({
        data: {
          sheets: [{ properties: { title: "Drivers", sheetId: 11 } }]
        }
      }),
      values: {
        get: async () => ({
          data: {
            values: [[
              "Driver ID",
              "Driver Name",
              "WhatsApp Number",
              "Status",
              "Current Location",
              "Working Hours",
              "Vehicle ID"
            ]]
          }
        })
      },
      batchUpdate: async (request) => {
        batchUpdateCalls.push(request);
        return {};
      }
    }
  };

  await applyTextFormatForHeaders({
    sheetsClient,
    spreadsheetId: "sheet-id",
    worksheetName: "Drivers",
    headerNames: ["Driver ID", "WhatsApp Number", "Vehicle ID"],
    logger: { info: () => {}, debug: () => {} }
  });

  assert.equal(batchUpdateCalls.length, 1);
  const requests = batchUpdateCalls[0].requestBody.requests;
  assert.equal(requests.length, 3);
  assert.deepEqual(
    requests.map((request) => request.repeatCell.range.startColumnIndex),
    [0, 2, 6]
  );
  assert.ok(
    requests.every(
      (request) => request.repeatCell.cell.userEnteredFormat.numberFormat.type === "TEXT"
    )
  );
});

test("classifyAppendFailure distinguishes common Google Sheets failures", () => {
  const auth = classifyAppendFailure({
    response: { status: 401, data: { error: { message: "Request had invalid credentials." } } }
  });
  assert.equal(auth.errorCode, "SHEETS_AUTH_FAILED");

  const perm = classifyAppendFailure({
    response: { status: 403, data: { error: { message: "The caller does not have permission" } } }
  });
  assert.equal(perm.errorCode, "SHEETS_PERMISSION_DENIED");

  const spread = classifyAppendFailure({
    response: {
      status: 404,
      data: { error: { message: "Requested entity was not found." } }
    }
  });
  assert.equal(spread.errorCode, "SHEETS_SPREADSHEET_NOT_FOUND");

  const worksheet = classifyAppendFailure({
    response: {
      status: 400,
      data: { error: { message: "Unable to parse range: MissingSheet!A:J" } }
    }
  });
  assert.equal(worksheet.errorCode, "SHEETS_WORKSHEET_NOT_FOUND");

  const timeout = classifyAppendFailure({
    code: "ETIMEDOUT",
    response: { status: 503, data: { error: { message: "Backend Error" } } }
  });
  assert.equal(timeout.errorCode, "SHEETS_NETWORK_TIMEOUT");
});
