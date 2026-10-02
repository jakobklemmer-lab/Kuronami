import { describe, expect, it } from "vitest";
import {
  type GatewayIdentity,
  authenticateTelegram,
  authenticateWeb,
  bearerToken,
  configuredChannels,
  identityFromEnv,
} from "./identity.js";

/**
 * Authentifizierung am Gateway (S16). Ohne Datenbank und ohne Netz — es geht um genau eine
 * Frage: kommt jemand herein, der nicht hereingehört.
 */

const identity: GatewayIdentity = {
  userId: "jakob",
  webToken: "web-geheim-1234",
  telegramSecret: "webhook-geheim-5678",
  telegramUserIds: ["11111111", "22222222"],
  voiceToken: "sprach-geheim-3456",
  voiceSessionToken: "",
};

describe("Web-Kanal", () => {
  it("lässt den richtigen Bearer-Token durch und trägt Nutzer und Absender ein", () => {
    const result = authenticateWeb(identity, { token: "web-geheim-1234", displayName: "CLI" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.userId).toBe("jakob");
    expect(result.principal.sender).toEqual({
      channel: "web",
      channelUserId: "jakob",
      displayName: "CLI",
      replyTo: "jakob",
    });
    expect(result.principal.authMethod).toBe("web:bearer");
  });

  it("weist einen falschen, einen leeren und einen fehlenden Token ab", () => {
    for (const token of ["web-geheim-1235", "web-geheim-123", "", null]) {
      const result = authenticateWeb(identity, { token });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(["bad_credential", "missing_credential"]).toContain(result.reason);
    }
  });

  it("nimmt nichts an, solange kein GATEWAY_WEB_TOKEN gesetzt ist", () => {
    // Ein leerer erwarteter Token darf nicht auf einen leeren mitgeschickten passen — sonst
    // wäre ein nicht eingerichteter Kanal der am weitesten offene.
    const result = authenticateWeb({ ...identity, webToken: "" }, { token: "" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("channel_not_configured");
  });

  it("liest den Bearer-Token aus dem Header, tolerant bei Leerzeichen", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("  Bearer   abc  ")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe("Telegram-Kanal", () => {
  const credential = {
    transport: "webhook" as const,
    secretHeader: "webhook-geheim-5678",
    fromId: "11111111",
    chatId: "11111111",
    displayName: "Jakob",
  };

  it("verlangt Webhook-Geheimnis **und** bekannten Absender", () => {
    const result = authenticateTelegram(identity, credential);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.userId).toBe("jakob");
    expect(result.principal.sender.channel).toBe("telegram");
    expect(result.principal.sender.channelUserId).toBe("11111111");
    expect(result.principal.authMethod).toBe("telegram:webhook");
  });

  it("weist einen fremden Absender ab, obwohl das Webhook-Geheimnis stimmt", () => {
    // Das ist der Fall, den ein Geheimnis allein nicht abdeckt: jeder Mensch kann dem Bot
    // schreiben, und sein Update trägt dasselbe gültige Geheimnis wie das des Betreibers.
    const result = authenticateTelegram(identity, { ...credential, fromId: "99999999" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_sender");
    expect(result.message).toContain("99999999");
  });

  it("weist ein falsches oder fehlendes Webhook-Geheimnis ab", () => {
    for (const secretHeader of ["falsch", "", null]) {
      const result = authenticateTelegram(identity, { ...credential, secretHeader });
      expect(result.ok).toBe(false);
    }
  });

  it("kommt beim Long-Polling ohne Header aus, prüft aber weiter den Absender", () => {
    const polling = { ...credential, transport: "polling" as const, secretHeader: null };

    expect(authenticateTelegram(identity, polling).ok).toBe(true);
    expect(authenticateTelegram(identity, { ...polling, fromId: "99999999" }).ok).toBe(false);
  });

  it("trennt Absender und Antwortadresse (Gruppenchat)", () => {
    const result = authenticateTelegram(identity, { ...credential, chatId: "-100777" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.sender.channelUserId).toBe("11111111");
    expect(result.principal.sender.replyTo).toBe("-100777");
  });

  it("nimmt ohne Absenderliste nichts an", () => {
    const result = authenticateTelegram({ ...identity, telegramUserIds: [] }, credential);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("channel_not_configured");
  });
});

describe("Identitätstabelle aus der Umgebung", () => {
  it("liest Nutzer, Token und Absenderliste, kommagetrennt und getrimmt", () => {
    const found = identityFromEnv({
      GATEWAY_USER_ID: " jakob ",
      GATEWAY_WEB_TOKEN: " abc ",
      TELEGRAM_WEBHOOK_SECRET: "def",
      TELEGRAM_ALLOWED_USER_IDS: " 111 , 222 ,, ",
    } as NodeJS.ProcessEnv);

    expect(found).toEqual({
      userId: "jakob",
      webToken: "abc",
      telegramSecret: "def",
      telegramUserIds: ["111", "222"],
      voiceToken: "",
      voiceSessionToken: "",
    });
    expect(configuredChannels(found)).toEqual(["web", "telegram"]);
  });

  it("liest das Sitzungsgeheimnis der Sprachschicht, getrimmt", () => {
    const found = identityFromEnv({
      GATEWAY_WEB_TOKEN: "abc",
      VOICE_SESSION_TOKEN: " sitzung-geheim ",
    } as NodeJS.ProcessEnv);

    expect(found.voiceSessionToken).toBe("sitzung-geheim");
    // Es schaltet keinen Kanal frei: der Gateway prüft diesen Token nie, er reicht ihn nur an
    // eine bereits ausgewiesene Oberfläche weiter. Der Sprach-Kanal hängt an VOICE_BRIDGE_TOKEN.
    expect(configuredChannels(found)).toEqual(["web"]);
  });

  it("schaltet einen Kanal ab, für den nichts gesetzt ist", () => {
    const onlyWeb = identityFromEnv({ GATEWAY_WEB_TOKEN: "abc" } as NodeJS.ProcessEnv);

    expect(configuredChannels(onlyWeb)).toEqual(["web"]);
    expect(configuredChannels(identityFromEnv({} as NodeJS.ProcessEnv))).toEqual([]);
  });
});
