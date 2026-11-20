import { createHmac } from "node:crypto";
import { assertWebhookUrl, signWebhook, WebhookUrlError } from "@taskflow/server";
import { describe, expect, it } from "vitest";

describe("webhook URL policy", () => {
  it("allows a public https URL and development loopback", async () => {
    await expect(assertWebhookUrl("https://1.1.1.1/hooks/taskflow", "production")).resolves.toBeInstanceOf(URL);
    await expect(assertWebhookUrl("http://127.0.0.1:4010/hooks", "development")).resolves.toBeInstanceOf(URL);
  });

  it("rejects private targets, credentials, and plain HTTP", async () => {
    await expect(assertWebhookUrl("https://10.1.2.3/hook", "development")).rejects.toBeInstanceOf(WebhookUrlError);
    await expect(assertWebhookUrl("https://127.0.0.1/hook", "production")).rejects.toBeInstanceOf(WebhookUrlError);
    await expect(assertWebhookUrl("http://example.com/hook", "development")).rejects.toBeInstanceOf(WebhookUrlError);
    await expect(assertWebhookUrl("https://user:secret@1.1.1.1/hook", "production")).rejects.toBeInstanceOf(WebhookUrlError);
    await expect(assertWebhookUrl("ftp://1.1.1.1/hook", "production")).rejects.toBeInstanceOf(WebhookUrlError);
  });
});

it("signs the timestamp and raw body", () => {
  const body = "{\"id\":\"whd_1\"}";
  const signature = signWebhook("whsec_test", 1_700_000_000, body);
  const expected = createHmac("sha256", "whsec_test").update(`1700000000.${body}`).digest("hex");
  expect(signature).toBe(expected);
});
