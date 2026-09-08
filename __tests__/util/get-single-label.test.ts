import { describe, expect, test, vi } from "vitest";
import { getSingleLabel } from "../../src/util/get-single-label.ts";

describe("getSingleLabel", () => {
  test("uses the injected fetch for translation", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify([[["Bonjour", "Hello"]]])));

    await expect(
      getSingleLabel(
        { en: ["Hello"] },
        { language: "fr", translate: true, fetch: request as typeof globalThis.fetch }
      )
    ).resolves.toBe("Bonjour");
    expect(request).toHaveBeenCalledOnce();
  });
});
