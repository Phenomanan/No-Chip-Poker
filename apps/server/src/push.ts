// Apple Push Notification service (APNs) sender, with no third-party dependency:
// token-based auth (an ES256 JWT signed with the .p8 key) over HTTP/2.
// Configure with APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_KEY (the .p8 text, or
// base64 of it) and optionally APNS_HOST (defaults to production; use
// https://api.sandbox.push.apple.com for development builds). Without them push is off.
import { createSign } from "node:crypto";
import http2 from "node:http2";

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
  key: string;
  host: string;
}

export interface PushMessage {
  title: string;
  body: string;
  roomCode?: string;
}

export interface PushResult {
  ok: boolean;
  status: number;
  reason?: string;
}

export function loadApnsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  const { APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_KEY } = env;
  if (!APNS_KEY_ID || !APNS_TEAM_ID || !APNS_BUNDLE_ID || !APNS_KEY) {
    return null;
  }
  const key = APNS_KEY.includes("BEGIN PRIVATE KEY") ? APNS_KEY : Buffer.from(APNS_KEY, "base64").toString("utf8");
  return {
    keyId: APNS_KEY_ID,
    teamId: APNS_TEAM_ID,
    bundleId: APNS_BUNDLE_ID,
    key: key.replace(/\\n/g, "\n"),
    host: env.APNS_HOST || "https://api.push.apple.com",
  };
}

const base64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

export class ApnsClient {
  private session: http2.ClientHttp2Session | null = null;
  private jwt: { token: string; issuedAt: number } | null = null;

  constructor(private readonly config: ApnsConfig) {}

  // Apple wants a fresh token at most every 20 minutes and no older than 60.
  private authToken(now = Date.now()): string {
    if (this.jwt && now - this.jwt.issuedAt < 40 * 60_000) {
      return this.jwt.token;
    }
    const issuedAt = Math.floor(now / 1000);
    const unsigned = `${base64url(JSON.stringify({ alg: "ES256", kid: this.config.keyId }))}.${base64url(
      JSON.stringify({ iss: this.config.teamId, iat: issuedAt })
    )}`;
    const signature = createSign("SHA256").update(unsigned).sign({ key: this.config.key, dsaEncoding: "ieee-p1363" });
    const token = `${unsigned}.${base64url(signature)}`;
    this.jwt = { token, issuedAt: now };
    return token;
  }

  private connection(): http2.ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) {
      return this.session;
    }
    const session = http2.connect(this.config.host);
    session.on("error", () => {
      this.session = null;
    });
    session.on("close", () => {
      if (this.session === session) {
        this.session = null;
      }
    });
    session.unref();
    this.session = session;
    return session;
  }

  send(deviceToken: string, message: PushMessage): Promise<PushResult> {
    const payload = JSON.stringify({
      aps: { alert: { title: message.title, body: message.body }, sound: "default", "thread-id": message.roomCode },
      roomCode: message.roomCode,
    });

    return new Promise((resolve) => {
      try {
        const request = this.connection().request({
          ":method": "POST",
          ":path": `/3/device/${deviceToken}`,
          authorization: `bearer ${this.authToken()}`,
          "apns-topic": this.config.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "content-type": "application/json",
        });
        let status = 0;
        let body = "";
        request.setEncoding("utf8");
        request.on("response", (headers) => {
          status = Number(headers[":status"] ?? 0);
        });
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          let reason: string | undefined;
          try {
            reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined;
          } catch {
            reason = undefined;
          }
          resolve({ ok: status === 200, status, reason });
        });
        request.on("error", (error) => resolve({ ok: false, status: 0, reason: error.message }));
        request.setTimeout(10_000, () => {
          request.close();
          resolve({ ok: false, status: 0, reason: "timeout" });
        });
        request.end(payload);
      } catch (error) {
        resolve({ ok: false, status: 0, reason: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  close(): void {
    this.session?.close();
    this.session = null;
  }
}
