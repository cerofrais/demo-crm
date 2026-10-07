import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCall, normalizeInboundPhone, plivoWebhookBases } from "./plivo";

describe("normalizeInboundPhone", () => {
  it("prepends + to Plivo's bare-digit inbound From value", () => {
    expect(normalizeInboundPhone("919876543210")).toBe("+919876543210");
  });

  it("leaves an already-E.164 value unchanged", () => {
    expect(normalizeInboundPhone("+919876543210")).toBe("+919876543210");
  });

  it("trims surrounding whitespace before checking for +", () => {
    expect(normalizeInboundPhone("  919876543210  ")).toBe("+919876543210");
  });

  it("leaves an empty value empty rather than returning a bare '+'", () => {
    expect(normalizeInboundPhone("")).toBe("");
    expect(normalizeInboundPhone("   ")).toBe("");
  });

  it("prepends +91 (not just +) to a bare 10-digit local number with no country code", () => {
    // Some carrier routes report caller ID this way instead of Plivo's usual
    // bare-digits-with-country-code — a bare "+" here would produce
    // "+9848052531", one country code short of Guest.phone/E.164.
    expect(normalizeInboundPhone("9848052531")).toBe("+919848052531");
  });

  it("does not mistake a 10-digit number starting 0-5 for a local Indian mobile", () => {
    // Not a valid Indian mobile prefix — left as a bare "+" rather than
    // guessing a country code that might be wrong.
    expect(normalizeInboundPhone("0123456789")).toBe("+0123456789");
  });
});

describe("plivoWebhookBases", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("puts the primary first and the fallback second", () => {
    process.env.PLIVO_WEBHOOK_BASE_URL = "https://primary.example";
    process.env.PLIVO_WEBHOOK_FALLBACK_BASE_URL = "https://backup.example";
    process.env.NEXTAUTH_URL = "https://app.example";
    expect(plivoWebhookBases()).toEqual([
      "https://primary.example",
      "https://backup.example",
    ]);
  });

  it("never lets NEXTAUTH_URL become the fallback origin when none is configured", () => {
    // It used to be a third entry, so clearing the fallback var just promoted
    // NEXTAUTH_URL (a tailnet host, absent from public DNS) into the
    // fallback_url slot — and Plivo 400s the whole createCall for that.
    process.env.PLIVO_WEBHOOK_BASE_URL = "https://primary.example";
    process.env.PLIVO_WEBHOOK_FALLBACK_BASE_URL = "";
    process.env.NEXTAUTH_URL = "https://app.tailnet.ts.net";
    expect(plivoWebhookBases()).toEqual(["https://primary.example"]);
  });

  it("trims trailing slashes so the signed URL isn't doubled up", () => {
    process.env.PLIVO_WEBHOOK_BASE_URL = "https://primary.example/";
    delete process.env.PLIVO_WEBHOOK_FALLBACK_BASE_URL;
    delete process.env.NEXTAUTH_URL;
    expect(plivoWebhookBases()).toEqual(["https://primary.example"]);
  });

  it("dedupes, so a fallback pointing at the primary isn't offered as failover", () => {
    // Handing Plivo a fallback_url identical to the answer_url would make the
    // retry hit the exact host that just failed.
    process.env.PLIVO_WEBHOOK_BASE_URL = "https://same.example";
    process.env.PLIVO_WEBHOOK_FALLBACK_BASE_URL = "https://same.example/";
    delete process.env.NEXTAUTH_URL;
    expect(plivoWebhookBases()).toEqual(["https://same.example"]);
  });

  it("skips blank values rather than producing an empty origin", () => {
    process.env.PLIVO_WEBHOOK_BASE_URL = "";
    process.env.PLIVO_WEBHOOK_FALLBACK_BASE_URL = "   ";
    process.env.NEXTAUTH_URL = "https://app.example";
    expect(plivoWebhookBases()).toEqual(["https://app.example"]);
  });
});

describe("createCall fallback_url handling", () => {
  const saved = globalThis.fetch;
  const args = {
    to: "+919876543210",
    answerUrl: "https://primary.example/api/plivo/outbound-answer",
    fallbackUrl: "https://backup.example/api/plivo/outbound-answer",
    hangupUrl: "https://primary.example/api/plivo/outbound-hangup",
    customData: "{}",
  };
  const ok = () =>
    new Response(JSON.stringify({ request_uuid: "uuid-1", message: "call queued" }), { status: 200 });
  const rejectsFallback = () =>
    new Response(JSON.stringify({ error: "fallback_url parameter is not valid" }), { status: 400 });

  const sentBodies = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));

  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = saved;
    vi.restoreAllMocks();
  });

  it("sends fallback_url when a fallback origin is configured", async () => {
    fetchMock.mockResolvedValueOnce(ok());
    await createCall(args);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBodies(fetchMock)[0].fallback_url).toBe(args.fallbackUrl);
  });

  it("omits fallback_url entirely when no fallback origin is configured", async () => {
    fetchMock.mockResolvedValueOnce(ok());
    await createCall({ ...args, fallbackUrl: undefined });
    expect(sentBodies(fetchMock)[0]).not.toHaveProperty("fallback_url");
  });

  it("retries on the primary alone when Plivo rejects the fallback, rather than failing the call", async () => {
    // Plivo resolves fallback_url at call-creation time and 400s the whole
    // request if the host isn't in public DNS — which took out 100% of
    // outbound calls, not just failover.
    fetchMock.mockResolvedValueOnce(rejectsFallback()).mockResolvedValueOnce(ok());
    const res = await createCall(args);
    expect(res.requestUUID).toBe("uuid-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = sentBodies(fetchMock);
    expect(first.fallback_url).toBe(args.fallbackUrl);
    expect(second).not.toHaveProperty("fallback_url");
    expect(second.answer_url).toBe(args.answerUrl);
  });

  it("does not retry a 400 that is about something other than the fallback", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "to parameter is not a valid number" }), { status: 400 }),
    );
    await expect(createCall(args)).rejects.toThrow(/to parameter/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the error when the retry fails too, instead of hanging on a stale response", async () => {
    fetchMock
      .mockResolvedValueOnce(rejectsFallback())
      .mockResolvedValueOnce(new Response("upstream boom", { status: 500 }));
    await expect(createCall(args)).rejects.toThrow(/500.*upstream boom/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
