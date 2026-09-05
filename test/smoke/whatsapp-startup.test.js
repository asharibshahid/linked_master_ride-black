const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { initializeWhatsAppClient } = require("../../src/whatsapp/client");
const { createSilentLogger } = require("../helpers");

class FakeWhatsAppClient extends EventEmitter {
  constructor(mode) {
    super();
    this.mode = mode;
    this.initializeCalled = false;
    this.destroyCalled = false;
  }

  async initialize() {
    this.initializeCalled = true;

    setTimeout(() => {
      this.emit("change_state", "OPENING");
      if (this.mode === "ready") {
        this.emit("authenticated");
        this.emit("ready");
      }
      if (this.mode === "auth_failure") {
        this.emit("auth_failure", "invalid session");
      }
      if (this.mode === "qr_then_ready") {
        this.emit("qr", "FAKE-QR-TOKEN");
        setTimeout(() => {
          this.emit("authenticated");
          this.emit("ready");
        }, 15);
      }
    }, 20);
  }

  async destroy() {
    this.destroyCalled = true;
  }
}

function createTempSessionPath() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ride-bot-wa-"));
}

function removeDirectory(dirPath) {
  if (!dirPath) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
}

test("WhatsApp startup resolves when ready event arrives", async () => {
  const tempPath = createTempSessionPath();
  const fakeClient = new FakeWhatsAppClient("ready");
  let createdClient = null;

  try {
    const client = await initializeWhatsAppClient({
      sessionPath: tempPath,
      clientId: "startup-smoke",
      startupTimeoutMs: 120,
      startupTimeoutMinMs: 50,
      persistedSessionDetected: true,
      logger: createSilentLogger(),
      qrRenderer: () => {},
      onClientCreated: (client) => { createdClient = client; },
      clientFactory: () => fakeClient
    });

    assert.equal(client, fakeClient);
    assert.equal(createdClient, fakeClient);
    assert.equal(fakeClient.initializeCalled, true);
  } finally {
    removeDirectory(tempPath);
  }
});

test("WhatsApp startup fails with explicit timeout code when stale auto-clear is enabled", async () => {
  const tempPath = createTempSessionPath();
  const fakeClient = new FakeWhatsAppClient("stall");

  try {
    await assert.rejects(
      () =>
        initializeWhatsAppClient({
          sessionPath: tempPath,
          clientId: "startup-timeout",
          startupTimeoutMs: 120,
          startupTimeoutMinMs: 50,
          persistedSessionDetected: true,
          autoClearStaleSession: true,
          logger: createSilentLogger(),
          qrRenderer: () => {},
          clientFactory: () => fakeClient
        }),
      (error) => {
        assert.equal(error?.code, "WHATSAPP_STARTUP_TIMEOUT");
        return true;
      }
    );
  } finally {
    removeDirectory(tempPath);
  }
});

test("WhatsApp startup preserves stalled saved session when stale auto-clear is disabled", async () => {
  const tempPath = createTempSessionPath();
  const clientId = "startup-preserve-stalled";
  const sessionFolderPath = path.join(tempPath, `session-${clientId}`);
  fs.mkdirSync(sessionFolderPath, { recursive: true });
  fs.writeFileSync(path.join(sessionFolderPath, "session.txt"), "saved session", "utf8");
  const fakeClient = new FakeWhatsAppClient("stall");
  const states = [];

  try {
    const result = await Promise.race([
      initializeWhatsAppClient({
        sessionPath: tempPath,
        clientId,
        startupTimeoutMs: 120,
        startupTimeoutMinMs: 50,
        persistedSessionDetected: true,
        autoClearStaleSession: false,
        logger: createSilentLogger(),
        qrRenderer: () => {},
        onStateChange: (state) => {
          states.push(state);
        },
        clientFactory: () => fakeClient
      }).then(
        () => "resolved",
        () => "rejected"
      ),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 180))
    ]);

    assert.equal(result, "waiting");
    assert.equal(fakeClient.initializeCalled, true);
    assert.equal(fakeClient.destroyCalled, false);
    assert.equal(fs.existsSync(sessionFolderPath), true);
    assert.ok(states.includes("startup_timeout"));
  } finally {
    removeDirectory(tempPath);
  }
});

test("WhatsApp startup clears stale persisted session and retries with QR recovery", async () => {
  const tempPath = createTempSessionPath();
  const clientId = "startup-stale-retry";
  const sessionFolderPath = path.join(tempPath, `session-${clientId}`);
  fs.mkdirSync(sessionFolderPath, { recursive: true });
  fs.writeFileSync(path.join(sessionFolderPath, "stale.txt"), "old session", "utf8");

  const firstClient = new FakeWhatsAppClient("stall");
  const secondClient = new FakeWhatsAppClient("qr_then_ready");
  const clients = [firstClient, secondClient];
  const states = [];

  try {
    const client = await initializeWhatsAppClient({
      sessionPath: tempPath,
      clientId,
      startupTimeoutMs: 120,
      startupTimeoutMinMs: 50,
      persistedSessionDetected: true,
      autoClearStaleSession: true,
      logger: createSilentLogger(),
      qrRenderer: () => {},
      onStateChange: (state) => {
        states.push(state);
      },
      clientFactory: () => clients.shift()
    });

    assert.equal(client, secondClient);
    assert.equal(firstClient.destroyCalled, true);
    assert.equal(secondClient.initializeCalled, true);
    assert.ok(states.includes("qr_required"));
    assert.ok(states.includes("ready"));
  } finally {
    removeDirectory(tempPath);
  }
});

test("WhatsApp startup saves QR image and reports state transitions", async () => {
  const tempPath = createTempSessionPath();
  const qrImagePath = path.join(tempPath, "qr.png");
  const fakeClient = new FakeWhatsAppClient("qr_then_ready");
  const states = [];

  try {
    await initializeWhatsAppClient({
      sessionPath: tempPath,
      clientId: "startup-qr",
      startupTimeoutMs: 250,
      startupTimeoutMinMs: 50,
      persistedSessionDetected: false,
      logger: createSilentLogger(),
      qrRenderer: () => {},
      qrImagePath,
      qrImageGenerator: {
        toFile: async (filePath, qrValue) => {
          fs.writeFileSync(filePath, `png:${qrValue}`, "utf8");
        }
      },
      onStateChange: (state) => {
        states.push(state);
      },
      clientFactory: () => fakeClient
    });

    assert.equal(fakeClient.initializeCalled, true);
    assert.ok(states.includes("starting"));
    assert.ok(states.includes("qr_required"));
    assert.ok(states.includes("authenticated"));
    assert.ok(states.includes("ready"));
    assert.equal(fs.existsSync(qrImagePath), false);
  } finally {
    removeDirectory(tempPath);
  }
});
