const { safeTrim } = require("../utils/text");
const { buildSuggestedBidEntries, hasBidTrackerEntry } = require("../bids/tracker");
const { CRITERIA_KEYS } = require("../settings/criteria");
const {
  DRIVER_HEADERS,
  VEHICLE_HEADERS,
  resolveNextDriverId
} = require("../drivers/management");
const { buildSheetRowObject } = require("../extraction/schemas");

const DRIVER_STATUS_VALUES = Object.freeze(["Available", "Busy", "Offline"]);
const VEHICLE_STATUS_VALUES = Object.freeze(["Available", "Busy", "Offline"]);
const FINAL_BID_STATUS_VALUES = Object.freeze(["Pending", "Approved", "Rejected"]);
const BID_ADMIN_STATUS_VALUES = Object.freeze(["Pending", "Approved", "Rejected"]);
const BID_STATUS_VALUES = Object.freeze(["Suggested", "Approved", "Bid Done", "Bid Failed", "Skipped"]);
const CLOSED_SCHEDULE_STATUSES = Object.freeze(["Completed", "Cancelled", "Canceled", "Failed"]);
const NEEDS_REVIEW_EDITABLE_FIELDS = Object.freeze({
  pickupDayDate: "Pickup Day & Date",
  startingTiming: "Starting Timing",
  pickup: "Pickup",
  dropOff: "Drop Off",
  distance: "Distance",
  fare: "Fare",
  requiredVehicle: "Required Vehicle",
  paymentStatus: "Payment Status"
});

function toCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeComparable(value) {
  return toCell(value).toLowerCase();
}

function isClosedScheduleStatus(value) {
  return CLOSED_SCHEDULE_STATUSES.map(normalizeComparable).includes(normalizeComparable(value));
}

function quoteSheetName(sheetName) {
  return `'${String(sheetName || "").replace(/'/g, "''")}'`;
}

function columnLetter(index1Based) {
  let n = Number(index1Based);
  let output = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    output = String.fromCharCode(65 + rem) + output;
    n = Math.floor((n - 1) / 26);
  }
  return output || "A";
}

function normalizeAllowedValue(value, allowedValues, fieldName) {
  const normalized = normalizeComparable(value);
  const match = allowedValues.find((item) => normalizeComparable(item) === normalized);
  if (!match) {
    throw new Error(`${fieldName} must be one of: ${allowedValues.join(", ")}`);
  }
  return match;
}

function findHeaderIndex(headers = [], headerName) {
  const normalized = normalizeComparable(headerName);
  return (Array.isArray(headers) ? headers : []).findIndex(
    (header) => normalizeComparable(header) === normalized
  );
}

function findFirstExistingHeaderIndex(headers = [], headerNames = []) {
  for (const headerName of headerNames) {
    const index = findHeaderIndex(headers, headerName);
    if (index >= 0) return index;
  }
  return -1;
}

function valuesToSheet(headers = [], rows = []) {
  return {
    headers: (Array.isArray(headers) ? headers : []).map(toCell),
    rows: Array.isArray(rows) ? rows : []
  };
}

function mapRowsToRecords(headers = [], rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const record = {};
    (Array.isArray(headers) ? headers : []).forEach((header, index) => {
      if (header) record[header] = toCell(row?.[index]);
    });
    return record;
  });
}

function recordToRow(headers = [], record = {}) {
  return (Array.isArray(headers) ? headers : []).map((header) => toCell(record?.[header]));
}

function getSheetHeadersOrDefault(sheet = {}, defaultHeaders = []) {
  return Array.isArray(sheet.headers) && sheet.headers.length > 0
    ? sheet.headers
    : [...defaultHeaders];
}

function assertUniqueColumnValue({
  worksheetName,
  headers,
  rows,
  columnHeaders,
  value,
  label
}) {
  const cleanValue = normalizeComparable(value);
  if (!cleanValue) return;
  const index = findFirstExistingHeaderIndex(headers, columnHeaders);
  if (index < 0) return;
  const exists = (Array.isArray(rows) ? rows : []).some(
    (row) => normalizeComparable(row?.[index]) === cleanValue
  );
  if (exists) {
    throw new Error(`${worksheetName} already has ${label || columnHeaders[0]}: ${value}`);
  }
}

function resolveNextVehicleId(records = []) {
  const maxId = (Array.isArray(records) ? records : []).reduce((max, record) => {
    const text = toCell(record?.["Vehicle ID"] || record?.vehicle_id);
    const match = text.match(/(\d+)$/);
    if (!match) return max;
    return Math.max(max, Number(match[1]));
  }, 0);

  return `V-${String(maxId + 1).padStart(3, "0")}`;
}

async function appendSheetRow({
  sheetsClient,
  spreadsheetId,
  worksheetName,
  values
}) {
  if (!sheetsClient) throw new Error("Google Sheets client is not configured");
  if (!spreadsheetId) throw new Error("Spreadsheet ID is missing");
  if (!worksheetName) throw new Error("Worksheet name is missing");

  const range = quoteSheetName(worksheetName);
  const response = await sheetsClient.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [values]
    }
  });

  return {
    range,
    values,
    updatedRange: response?.data?.updates?.updatedRange || ""
  };
}

async function readSheetValues({ sheetsClient, spreadsheetId, worksheetName }) {
  if (!sheetsClient) throw new Error("Google Sheets client is not configured");
  if (!spreadsheetId) throw new Error("Spreadsheet ID is missing");
  if (!worksheetName) throw new Error("Worksheet name is missing");

  const response = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteSheetName(worksheetName)}!A:Z`,
    majorDimension: "ROWS"
  });
  const values = Array.isArray(response?.data?.values) ? response.data.values : [];
  return valuesToSheet(values[0] || [], values.slice(1));
}

async function updateSheetCell({
  sheetsClient,
  spreadsheetId,
  worksheetName,
  rowNumber,
  columnIndex,
  value
}) {
  const column = columnLetter(columnIndex + 1);
  const range = `${quoteSheetName(worksheetName)}!${column}${rowNumber}`;
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: {
      values: [[toCell(value)]]
    }
  });

  return { range, value: toCell(value) };
}

async function updateRowCellByKey({
  sheetsClient,
  spreadsheetId,
  worksheetName,
  keyHeaders,
  keyValue,
  targetHeader,
  value,
  disallowedOldValues = []
}) {
  const sheet = await readSheetValues({ sheetsClient, spreadsheetId, worksheetName });
  const keyIndex = findFirstExistingHeaderIndex(sheet.headers, keyHeaders);
  const targetIndex = findHeaderIndex(sheet.headers, targetHeader);

  if (keyIndex < 0) {
    throw new Error(`${worksheetName} is missing key column: ${keyHeaders.join(" / ")}`);
  }
  if (targetIndex < 0) {
    throw new Error(`${worksheetName} is missing ${targetHeader} column`);
  }

  const normalizedKey = normalizeComparable(keyValue);
  if (!normalizedKey) throw new Error("Row key value is missing");

  const rowIndex = sheet.rows.findIndex(
    (row) => normalizeComparable(row?.[keyIndex]) === normalizedKey
  );
  if (rowIndex < 0) {
    throw new Error(`${worksheetName} row not found for ${keyValue}`);
  }

  const rowNumber = rowIndex + 2;
  const oldValue = toCell(sheet.rows[rowIndex]?.[targetIndex]);
  const blockedOldValues = new Set(
    (Array.isArray(disallowedOldValues) ? disallowedOldValues : []).map(normalizeComparable)
  );
  if (blockedOldValues.has(normalizeComparable(oldValue))) {
    throw new Error(`${worksheetName} row ${keyValue} is closed and cannot be updated from ${oldValue}`);
  }
  const update = await updateSheetCell({
    sheetsClient,
    spreadsheetId,
    worksheetName,
    rowNumber,
    columnIndex: targetIndex,
    value
  });

  return {
    worksheetName,
    rowNumber,
    header: targetHeader,
    key: keyValue,
    oldValue,
    ...update
  };
}

async function updateDriverStatus(options = {}) {
  const status = normalizeAllowedValue(
    options.status,
    DRIVER_STATUS_VALUES,
    "Driver status"
  );

  return updateRowCellByKey({
    sheetsClient: options.sheetsClient,
    spreadsheetId: options.spreadsheetId,
    worksheetName: options.driversWorksheetName || "Drivers",
    keyHeaders: ["Driver ID"],
    keyValue: options.driverId,
    targetHeader: "Status",
    value: status
  });
}

async function updateVehicleStatus(options = {}) {
  const status = normalizeAllowedValue(
    options.status,
    VEHICLE_STATUS_VALUES,
    "Vehicle status"
  );

  return updateRowCellByKey({
    sheetsClient: options.sheetsClient,
    spreadsheetId: options.spreadsheetId,
    worksheetName: options.vehiclesWorksheetName || "Vehicles",
    keyHeaders: ["Vehicle ID"],
    keyValue: options.vehicleId,
    targetHeader: "Status",
    value: status
  });
}

async function createDriverRecord(options = {}) {
  const worksheetName = options.driversWorksheetName || "Drivers";
  const sheet = await readSheetValues({
    sheetsClient: options.sheetsClient,
    spreadsheetId: options.spreadsheetId,
    worksheetName
  });
  const headers = getSheetHeadersOrDefault(sheet, DRIVER_HEADERS);
  const records = mapRowsToRecords(headers, sheet.rows);
  const driverId = toCell(options.driverId) || resolveNextDriverId(records);
  const driverName = toCell(options.driverName || options["Driver Name"]);
  const status = normalizeAllowedValue(
    options.status || "Available",
    DRIVER_STATUS_VALUES,
    "Driver status"
  );

  if (!driverId) throw new Error("Driver ID is missing");
  if (!driverName) throw new Error("Driver Name is required");
  assertUniqueColumnValue({
    worksheetName,
    headers,
    rows: sheet.rows,
    columnHeaders: ["Driver ID"],
    value: driverId,
    label: "Driver ID"
  });

  const record = {
    "Driver ID": driverId,
    "Driver Name": driverName,
    "WhatsApp Number": toCell(options.whatsappNumber || options["WhatsApp Number"]),
    Status: status,
    "Current Location": toCell(options.currentLocation || options["Current Location"]),
    "Working Hours": toCell(options.workingHours || options["Working Hours"] || "Any"),
    "Vehicle ID": toCell(options.vehicleId || options["Vehicle ID"])
  };
  const values = recordToRow(headers, record);
  const append = await appendSheetRow({
    sheetsClient: options.sheetsClient,
    spreadsheetId: options.spreadsheetId,
    worksheetName,
    values
  });

  return {
    worksheetName,
    key: driverId,
    header: "Driver ID",
    oldValue: "",
    value: driverId,
    record,
    ...append
  };
}

async function createVehicleRecord(options = {}) {
  const worksheetName = options.vehiclesWorksheetName || "Vehicles";
  const sheet = await readSheetValues({
    sheetsClient: options.sheetsClient,
    spreadsheetId: options.spreadsheetId,
    worksheetName
  });
  const headers = getSheetHeadersOrDefault(sheet, VEHICLE_HEADERS);
  const records = mapRowsToRecords(headers, sheet.rows);
  const vehicleId = toCell(options.vehicleId) || resolveNextVehicleId(records);
  const vehicleType = toCell(options.vehicleType || options["Vehicle Type"]);
  const status = normalizeAllowedValue(
    options.status || "Available",
    VEHICLE_STATUS_VALUES,
    "Vehicle status"
  );

  if (!vehicleId) throw new Error("Vehicle ID is missing");
  if (!vehicleType) throw new Error("Vehicle Type is required");
  assertUniqueColumnValue({
    worksheetName,
    headers,
    rows: sheet.rows,
    columnHeaders: ["Vehicle ID"],
    value: vehicleId,
    label: "Vehicle ID"
  });
  assertUniqueColumnValue({
    worksheetName,
    headers,
    rows: sheet.rows,
    columnHeaders: ["Registration"],
    value: options.registration || options.Registration,
    label: "Registration"
  });

  const record = {
    "Vehicle ID": vehicleId,
    "Vehicle Type": vehicleType,
    Seats: toCell(options.seats || options.Seats),
    Registration: toCell(options.registration || options.Registration),
    "Driver ID": toCell(options.driverId || options["Driver ID"]),
    Status: status
  };
  const values = recordToRow(headers, record);
  const append = await appendSheetRow({
    sheetsClient: options.sheetsClient,
    spreadsheetId: options.spreadsheetId,
    worksheetName,
    values
  });

  return {
    worksheetName,
    key: vehicleId,
    header: "Vehicle ID",
    oldValue: "",
    value: vehicleId,
    record,
    ...append
  };
}

async function updateFinalBidStatus(options = {}) {
  const status = normalizeAllowedValue(
    options.status,
    FINAL_BID_STATUS_VALUES,
    "Final Bid status"
  );

  return updateRowCellByKey({
    sheetsClient: options.sheetsClient,
    spreadsheetId: options.spreadsheetId,
    worksheetName: options.finalBidWorksheetName || "Final Bid",
    keyHeaders: ["Refer", "Ride ID"],
    keyValue: options.rideId,
    targetHeader: "Status",
    value: status,
    disallowedOldValues: ["Rejected", "Cancelled", "Canceled", "Completed"]
  });
}

async function resetFinalBidCalendarRetry(options = {}) {
  const sheet = await readSheetValues({
    sheetsClient: options.sheetsClient,
    spreadsheetId: options.spreadsheetId,
    worksheetName: options.finalBidWorksheetName || "Final Bid"
  });
  const keyIndex = findFirstExistingHeaderIndex(sheet.headers, ["Refer", "Ride ID"]);
  if (keyIndex < 0) {
    throw new Error(`${options.finalBidWorksheetName || "Final Bid"} is missing key column: Refer / Ride ID`);
  }

  const normalizedKey = normalizeComparable(options.rideId);
  if (!normalizedKey) throw new Error("Ride ID is missing");
  const rowIndex = sheet.rows.findIndex(
    (row) => normalizeComparable(row?.[keyIndex]) === normalizedKey
  );
  if (rowIndex < 0) {
    throw new Error(`${options.finalBidWorksheetName || "Final Bid"} row not found for ${options.rideId}`);
  }

  const updates = [];
  const rowNumber = rowIndex + 2;
  for (const header of ["Calendar Status", "Calendar Created Time", "Calendar Error"]) {
    const columnIndex = findHeaderIndex(sheet.headers, header);
    if (columnIndex < 0) {
      if (header === "Calendar Status") {
        throw new Error(`${options.finalBidWorksheetName || "Final Bid"} is missing Calendar Status column`);
      }
      continue;
    }

    const oldValue = toCell(sheet.rows[rowIndex]?.[columnIndex]);
    const update = await updateSheetCell({
      sheetsClient: options.sheetsClient,
      spreadsheetId: options.spreadsheetId,
      worksheetName: options.finalBidWorksheetName || "Final Bid",
      rowNumber,
      columnIndex,
      value: ""
    });
    updates.push({
      worksheetName: options.finalBidWorksheetName || "Final Bid",
      rowNumber,
      header,
      key: options.rideId,
      oldValue,
      ...update
    });
  }

  return { updates };
}

async function updateBidAdminStatus(options = {}) {
  const adminStatus = normalizeAllowedValue(
    options.adminStatus || options.status,
    BID_ADMIN_STATUS_VALUES,
    "Bid admin status"
  );

  const updates = [];
  updates.push(
    await updateRowCellByKey({
      sheetsClient: options.sheetsClient,
      spreadsheetId: options.spreadsheetId,
      worksheetName: options.bidTrackerWorksheetName || "Bid Tracker",
      keyHeaders: ["Ride ID"],
      keyValue: options.rideId,
      targetHeader: "Admin Status",
      value: adminStatus
    })
  );

  if (adminStatus === "Approved") {
    updates.push(
      await updateRowCellByKey({
        sheetsClient: options.sheetsClient,
        spreadsheetId: options.spreadsheetId,
        worksheetName: options.bidTrackerWorksheetName || "Bid Tracker",
        keyHeaders: ["Ride ID"],
        keyValue: options.rideId,
        targetHeader: "Bid Status",
        value: "Approved"
      })
    );
  }

  if (options.bidAmount !== undefined) {
    updates.push(
      await updateRowCellByKey({
        sheetsClient: options.sheetsClient,
        spreadsheetId: options.spreadsheetId,
        worksheetName: options.bidTrackerWorksheetName || "Bid Tracker",
        keyHeaders: ["Ride ID"],
        keyValue: options.rideId,
        targetHeader: "Bid Amount",
        value: options.bidAmount
      })
    );
  }

  if (options.reason !== undefined) {
    updates.push(
      await updateRowCellByKey({
        sheetsClient: options.sheetsClient,
        spreadsheetId: options.spreadsheetId,
        worksheetName: options.bidTrackerWorksheetName || "Bid Tracker",
        keyHeaders: ["Ride ID"],
        keyValue: options.rideId,
        targetHeader: "Reason",
        value: options.reason
      })
    );
  }

  updates.push(
    await updateRowCellByKey({
      sheetsClient: options.sheetsClient,
      spreadsheetId: options.spreadsheetId,
      worksheetName: options.bidTrackerWorksheetName || "Bid Tracker",
      keyHeaders: ["Ride ID"],
      keyValue: options.rideId,
      targetHeader: "Updated Time",
      value: new Date().toISOString()
    })
  );

  return { updates };
}

async function updateBidStatus(options = {}) {
  const bidStatus = normalizeAllowedValue(
    options.bidStatus || options.status,
    BID_STATUS_VALUES,
    "Bid status"
  );

  const updates = [];
  updates.push(
    await updateRowCellByKey({
      sheetsClient: options.sheetsClient,
      spreadsheetId: options.spreadsheetId,
      worksheetName: options.bidTrackerWorksheetName || "Bid Tracker",
      keyHeaders: ["Ride ID"],
      keyValue: options.rideId,
      targetHeader: "Bid Status",
      value: bidStatus
    })
  );

  if (options.bidAmount !== undefined) {
    updates.push(
      await updateRowCellByKey({
        sheetsClient: options.sheetsClient,
        spreadsheetId: options.spreadsheetId,
        worksheetName: options.bidTrackerWorksheetName || "Bid Tracker",
        keyHeaders: ["Ride ID"],
        keyValue: options.rideId,
        targetHeader: "Bid Amount",
        value: options.bidAmount
      })
    );
  }

  if (options.reason !== undefined) {
    updates.push(
      await updateRowCellByKey({
        sheetsClient: options.sheetsClient,
        spreadsheetId: options.spreadsheetId,
        worksheetName: options.bidTrackerWorksheetName || "Bid Tracker",
        keyHeaders: ["Ride ID"],
        keyValue: options.rideId,
        targetHeader: "Reason",
        value: options.reason
      })
    );
  }

  updates.push(
    await updateRowCellByKey({
      sheetsClient: options.sheetsClient,
      spreadsheetId: options.spreadsheetId,
      worksheetName: options.bidTrackerWorksheetName || "Bid Tracker",
      keyHeaders: ["Ride ID"],
      keyValue: options.rideId,
      targetHeader: "Updated Time",
      value: new Date().toISOString()
    })
  );

  return { updates };
}

async function updateNeedsReviewRideFields(options = {}) {
  const worksheetName = options.needsReviewWorksheetName || "Needs Review";
  const fields = options.fields && typeof options.fields === "object" ? options.fields : {};
  const updates = [];

  for (const [fieldName, header] of Object.entries(NEEDS_REVIEW_EDITABLE_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(fields, fieldName)) continue;
    updates.push(
      await updateRowCellByKey({
        sheetsClient: options.sheetsClient,
        spreadsheetId: options.spreadsheetId,
        worksheetName,
        keyHeaders: ["Refer", "Ride ID"],
        keyValue: options.rideId,
        targetHeader: header,
        value: fields[fieldName]
      })
    );
  }

  if (updates.length === 0) {
    throw new Error("No editable Needs Review fields were provided");
  }

  return { updates };
}

async function completeAssignedRideSchedules(options = {}) {
  const rideId = toCell(options.rideId);
  if (!rideId) throw new Error("Ride ID is missing");

  const driverScheduleWorksheetName = options.driverScheduleWorksheetName || "Driver Schedule";
  const vehicleScheduleWorksheetName = options.vehicleScheduleWorksheetName || "Vehicle Schedule";
  const driverScheduleSheet = await readSheetValues({
    sheetsClient: options.sheetsClient,
    spreadsheetId: options.spreadsheetId,
    worksheetName: driverScheduleWorksheetName
  });
  const vehicleScheduleSheet = await readSheetValues({
    sheetsClient: options.sheetsClient,
    spreadsheetId: options.spreadsheetId,
    worksheetName: vehicleScheduleWorksheetName
  });

  const normalizedRideId = normalizeComparable(rideId);
  const updates = [];
  const completedDriverRows = [];
  const completedVehicleRows = [];

  const completeRows = async ({ sheet, worksheetName, collector }) => {
    const rideIndex = findFirstExistingHeaderIndex(sheet.headers, ["Ride ID", "Refer"]);
    const statusIndex = findHeaderIndex(sheet.headers, "Status");
    if (rideIndex < 0) throw new Error(`${worksheetName} is missing Ride ID column`);
    if (statusIndex < 0) throw new Error(`${worksheetName} is missing Status column`);

    for (const [rowIndex, row] of sheet.rows.entries()) {
      if (normalizeComparable(row?.[rideIndex]) !== normalizedRideId) continue;
      const oldStatus = toCell(row?.[statusIndex]);
      if (isClosedScheduleStatus(oldStatus)) continue;
      const update = await updateSheetCell({
        sheetsClient: options.sheetsClient,
        spreadsheetId: options.spreadsheetId,
        worksheetName,
        rowNumber: rowIndex + 2,
        columnIndex: statusIndex,
        value: "Completed"
      });
      updates.push({
        worksheetName,
        rowNumber: rowIndex + 2,
        header: "Status",
        key: rideId,
        oldValue: oldStatus,
        ...update
      });
      collector.push({ rowIndex, row });
    }
  };

  await completeRows({
    sheet: driverScheduleSheet,
    worksheetName: driverScheduleWorksheetName,
    collector: completedDriverRows
  });
  await completeRows({
    sheet: vehicleScheduleSheet,
    worksheetName: vehicleScheduleWorksheetName,
    collector: completedVehicleRows
  });

  if (completedDriverRows.length === 0 && completedVehicleRows.length === 0) {
    return {
      completed: false,
      reason: "no_active_schedule_rows",
      updates
    };
  }

  const firstDriverRow = completedDriverRows[0]?.row || [];
  const driverIdIndex = findHeaderIndex(driverScheduleSheet.headers, "Driver ID");
  const dropOffIndex = findHeaderIndex(driverScheduleSheet.headers, "Drop Off");
  const currentLocationIndex = findHeaderIndex(driverScheduleSheet.headers, "Current Location");
  const driverId = toCell(firstDriverRow?.[driverIdIndex]);
  const currentLocation =
    toCell(firstDriverRow?.[dropOffIndex]) || toCell(firstDriverRow?.[currentLocationIndex]);

  if (driverId) {
    updates.push(
      await updateRowCellByKey({
        sheetsClient: options.sheetsClient,
        spreadsheetId: options.spreadsheetId,
        worksheetName: options.driversWorksheetName || "Drivers",
        keyHeaders: ["Driver ID"],
        keyValue: driverId,
        targetHeader: "Status",
        value: "Available"
      })
    );
    if (currentLocation) {
      updates.push(
        await updateRowCellByKey({
          sheetsClient: options.sheetsClient,
          spreadsheetId: options.spreadsheetId,
          worksheetName: options.driversWorksheetName || "Drivers",
          keyHeaders: ["Driver ID"],
          keyValue: driverId,
          targetHeader: "Current Location",
          value: currentLocation
        })
      );
    }
  }

  const firstVehicleRow = completedVehicleRows[0]?.row || [];
  const vehicleIdIndex = findHeaderIndex(vehicleScheduleSheet.headers, "Vehicle ID");
  const vehicleId = toCell(firstVehicleRow?.[vehicleIdIndex]);
  if (vehicleId) {
    updates.push(
      await updateRowCellByKey({
        sheetsClient: options.sheetsClient,
        spreadsheetId: options.spreadsheetId,
        worksheetName: options.vehiclesWorksheetName || "Vehicles",
        keyHeaders: ["Vehicle ID"],
        keyValue: vehicleId,
        targetHeader: "Status",
        value: "Available"
      })
    );
  }

  return {
    completed: true,
    reason: "completed",
    key: rideId,
    header: "Status",
    oldValue: "Assigned",
    value: "Completed",
    driverId,
    vehicleId,
    currentLocation,
    updates
  };
}

async function promoteNeedsReviewToFinalBid(options = {}) {
  if (typeof options.appendFinalBidIfEligible !== "function") {
    throw new Error("Final Bid append pipeline is not configured");
  }

  const needsReviewWorksheetName = options.needsReviewWorksheetName || "Needs Review";
  const finalBidWorksheetName = options.finalBidWorksheetName || "Final Bid";
  const needsReviewSheet = await readSheetValues({
    sheetsClient: options.sheetsClient,
    spreadsheetId: options.spreadsheetId,
    worksheetName: needsReviewWorksheetName
  });
  const finalBidSheet = await readSheetValues({
    sheetsClient: options.sheetsClient,
    spreadsheetId: options.spreadsheetId,
    worksheetName: finalBidWorksheetName
  });

  const keyIndex = findFirstExistingHeaderIndex(needsReviewSheet.headers, ["Refer", "Ride ID"]);
  if (keyIndex < 0) {
    throw new Error(`${needsReviewWorksheetName} is missing key column: Refer / Ride ID`);
  }

  const normalizedRideId = normalizeComparable(options.rideId);
  if (!normalizedRideId) throw new Error("Ride ID is missing");
  const rowIndex = needsReviewSheet.rows.findIndex(
    (row) => normalizeComparable(row?.[keyIndex]) === normalizedRideId
  );
  if (rowIndex < 0) {
    throw new Error(`${needsReviewWorksheetName} row not found for ${options.rideId}`);
  }

  const finalBidRecords = mapRowsToRecords(finalBidSheet.headers, finalBidSheet.rows);
  const alreadyInFinalBid = finalBidRecords.some(
    (record) => normalizeComparable(record.Refer || record["Ride ID"]) === normalizedRideId
  );
  if (alreadyInFinalBid) {
    return {
      appended: false,
      reason: "final_bid_entry_exists",
      updates: []
    };
  }

  const reviewRecords = mapRowsToRecords(needsReviewSheet.headers, needsReviewSheet.rows);
  const reviewRecord = reviewRecords[rowIndex] || {};
  const paymentStatus = normalizeComparable(reviewRecord["Payment Status"]);
  if (paymentStatus.includes("promoted to final bid")) {
    return {
      appended: false,
      reason: "already_promoted",
      updates: []
    };
  }

  const rowObject = buildSheetRowObject({
    refer: reviewRecord.Refer || reviewRecord["Ride ID"],
    group_name: reviewRecord["Group Name"],
    source_name: reviewRecord["Source Name"],
    source_time: reviewRecord["Source Time"],
    pickup_day_date: reviewRecord["Pickup Day & Date"] || reviewRecord.Date,
    starting_timing: reviewRecord["Starting Timing"] || reviewRecord.Time,
    pickup: reviewRecord.Pickup,
    drop_off: reviewRecord["Drop Off"],
    distance: reviewRecord.Distance,
    fare: reviewRecord.Fare,
    required_vehicle: reviewRecord["Required Vehicle"],
    payment_status: reviewRecord["Payment Status"]
  });
  const missing = [];
  if (!rowObject.Refer) missing.push("Refer");
  if (!rowObject["Pickup Day & Date"]) missing.push("Pickup Day & Date");
  if (!rowObject["Starting Timing"]) missing.push("Starting Timing");
  if (!rowObject.Pickup) missing.push("Pickup");
  if (!rowObject["Drop Off"]) missing.push("Drop Off");
  if (!rowObject.Fare) missing.push("Fare");
  if (!rowObject["Required Vehicle"]) missing.push("Required Vehicle");
  if (missing.length > 0) {
    throw new Error(`Needs Review row is incomplete: missing ${missing.join(", ")}`);
  }

  const ride = {
    refer: rowObject.Refer,
    group_name: rowObject["Group Name"],
    source_name: rowObject["Source Name"],
    source_time: rowObject["Source Time"],
    pickup_day_date: rowObject["Pickup Day & Date"],
    starting_timing: rowObject["Starting Timing"],
    pickup: rowObject.Pickup,
    drop_off: rowObject["Drop Off"],
    distance: rowObject.Distance,
    fare: rowObject.Fare,
    required_vehicle: rowObject["Required Vehicle"],
    payment_status: rowObject["Payment Status"]
  };
  const appendResult = await options.appendFinalBidIfEligible(ride);
  if (!appendResult?.appended) {
    throw new Error(`Needs Review row did not meet Final Bid criteria: ${appendResult?.reason || "not eligible"}`);
  }

  const paymentStatusIndex = findHeaderIndex(needsReviewSheet.headers, "Payment Status");
  const updates = [];
  if (paymentStatusIndex >= 0) {
    updates.push(
      await updateSheetCell({
        sheetsClient: options.sheetsClient,
        spreadsheetId: options.spreadsheetId,
        worksheetName: needsReviewWorksheetName,
        rowNumber: rowIndex + 2,
        columnIndex: paymentStatusIndex,
        value: `Promoted to Final Bid ${new Date().toISOString()}`
      })
    );
  }

  return {
    appended: true,
    reason: "promoted",
    key: rowObject.Refer,
    header: "Payment Status",
    oldValue: reviewRecord["Payment Status"] || "",
    value: updates[0]?.value || "Promoted to Final Bid",
    rowObject,
    appendResult,
    updates
  };
}

async function createBidReviewEntry(options = {}) {
  if (typeof options.appendBidTrackerRow !== "function") {
    throw new Error("Bid tracker append function is not configured");
  }

  const finalBidSheet = await readSheetValues({
    sheetsClient: options.sheetsClient,
    spreadsheetId: options.spreadsheetId,
    worksheetName: options.finalBidWorksheetName || "Final Bid"
  });
  const bidTrackerSheet = await readSheetValues({
    sheetsClient: options.sheetsClient,
    spreadsheetId: options.spreadsheetId,
    worksheetName: options.bidTrackerWorksheetName || "Bid Tracker"
  });

  const finalBidRecords = mapRowsToRecords(finalBidSheet.headers, finalBidSheet.rows);
  const bidTrackerRecords = mapRowsToRecords(bidTrackerSheet.headers, bidTrackerSheet.rows);
  const ride = finalBidRecords.find((record) => normalizeComparable(record.Refer || record["Ride ID"]) === normalizeComparable(options.rideId));
  if (!ride) throw new Error(`Final Bid row not found for ${options.rideId}`);
  if (hasBidTrackerEntry(bidTrackerRecords, options.rideId)) {
    return { appended: false, reason: "bid_tracker_entry_exists" };
  }

  const [entry] = buildSuggestedBidEntries([ride], bidTrackerRecords, {
    minFare: options.minFare
  });
  if (!entry) {
    throw new Error(`Ride is not eligible for bid review: ${options.rideId}`);
  }

  await options.appendBidTrackerRow(entry);
  return { appended: true, entry };
}

function assertAllowedCriteriaKey(key) {
  const normalized = safeTrim(key).toUpperCase();
  if (!Object.values(CRITERIA_KEYS).includes(normalized)) {
    throw new Error(`Unsupported dispatch criteria setting: ${key}`);
  }
  return normalized;
}

async function updateDispatchCriteria(options = {}) {
  const setting = assertAllowedCriteriaKey(options.setting);
  const value = toCell(options.value);
  const updates = [];
  updates.push(
    await updateRowCellByKey({
      sheetsClient: options.sheetsClient,
      spreadsheetId: options.spreadsheetId,
      worksheetName: options.dispatchCriteriaWorksheetName || "Dispatch Criteria",
      keyHeaders: ["Setting"],
      keyValue: setting,
      targetHeader: "Value",
      value
    })
  );
  updates.push(
    await updateRowCellByKey({
      sheetsClient: options.sheetsClient,
      spreadsheetId: options.spreadsheetId,
      worksheetName: options.dispatchCriteriaWorksheetName || "Dispatch Criteria",
      keyHeaders: ["Setting"],
      keyValue: setting,
      targetHeader: "Updated Time",
      value: new Date().toISOString()
    })
  );
  return { setting, value, updates };
}

async function approveRecommendation(options = {}) {
  const updates = [];
  updates.push(
    await updateRowCellByKey({
      sheetsClient: options.sheetsClient,
      spreadsheetId: options.spreadsheetId,
      worksheetName: options.recommendationsWorksheetName || "Driver Recommendations",
      keyHeaders: ["Ride ID"],
      keyValue: options.rideId,
      targetHeader: "Status",
      value: "Approved"
    })
  );

  try {
    updates.push(
      await updateRowCellByKey({
        sheetsClient: options.sheetsClient,
        spreadsheetId: options.spreadsheetId,
        worksheetName: options.recommendationsWorksheetName || "Driver Recommendations",
        keyHeaders: ["Ride ID"],
        keyValue: options.rideId,
        targetHeader: "Assignment Status",
        value: "Approved"
      })
    );
  } catch (error) {
    if (!/Assignment Status column/i.test(safeTrim(error?.message))) {
      throw error;
    }
  }

  return { updates };
}

module.exports = {
  DRIVER_STATUS_VALUES,
  VEHICLE_STATUS_VALUES,
  FINAL_BID_STATUS_VALUES,
  BID_ADMIN_STATUS_VALUES,
  BID_STATUS_VALUES,
  CLOSED_SCHEDULE_STATUSES,
  NEEDS_REVIEW_EDITABLE_FIELDS,
  columnLetter,
  findHeaderIndex,
  readSheetValues,
  updateRowCellByKey,
  createDriverRecord,
  createVehicleRecord,
  promoteNeedsReviewToFinalBid,
  createBidReviewEntry,
  updateDispatchCriteria,
  updateDriverStatus,
  updateVehicleStatus,
  updateFinalBidStatus,
  updateNeedsReviewRideFields,
  completeAssignedRideSchedules,
  resetFinalBidCalendarRetry,
  updateBidAdminStatus,
  updateBidStatus,
  approveRecommendation
};
