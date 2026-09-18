import { describe, expect, it } from "vitest";
import { resolveBackendOrigin } from "./backend-origin.js";

describe("resolveBackendOrigin", () => {
  it("nimmt lokal denselben Host mit Port 3000 (Vorgabe, kein Präfix)", () => {
    expect(resolveBackendOrigin("localhost", false, null)).toEqual({
      http: "http://localhost:3000",
      ws: "ws://localhost:3000/events",
      voiceWs: "ws://localhost:8790",
    });
  });

  it("übernimmt einen expliziten Port auch bei sonst passendem Präfix", () => {
    expect(resolveBackendOrigin("kuronami.example.test", true, "3005")).toEqual({
      http: "https://kuronami.example.test:3005",
      ws: "wss://kuronami.example.test:3005/events",
      voiceWs: "wss://kuronami.example.test:8790",
    });
  });

  it("bildet hinter dem Reverse-Proxy die gateway.-Subdomain aus derselben Domain", () => {
    expect(resolveBackendOrigin("kuronami.203-0-113-7.sslip.io", true, null)).toEqual({
      http: "https://gateway.203-0-113-7.sslip.io",
      ws: "wss://gateway.203-0-113-7.sslip.io/events",
      voiceWs: "wss://voice.203-0-113-7.sslip.io",
    });
  });

  it("verwendet ws/http (nicht wss/https) ohne HTTPS", () => {
    expect(resolveBackendOrigin("kuronami.example.test", false, null)).toEqual({
      http: "http://gateway.example.test",
      ws: "ws://gateway.example.test/events",
      voiceWs: "ws://voice.example.test",
    });
  });

  it("fällt für einen Host ohne das Präfix auf das alte Portschema zurück", () => {
    expect(resolveBackendOrigin("203.0.113.7", true, null)).toEqual({
      http: "https://203.0.113.7:3000",
      ws: "wss://203.0.113.7:3000/events",
      voiceWs: "wss://203.0.113.7:8790",
    });
  });
});
