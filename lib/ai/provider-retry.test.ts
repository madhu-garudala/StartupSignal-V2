import { describe, expect, it, vi } from "vitest";
import { isTransientProviderError, withTransientProviderRetry } from "@/lib/ai/provider-retry";

describe("provider retry", () => {
  it.each([429, 500, 503])("classifies HTTP %s as transient", (status) => {
    expect(isTransientProviderError(Object.assign(new Error("temporary"), { status }))).toBe(true);
  });

  it.each([400, 401, 403, 422])("does not retry HTTP %s", (status) => {
    expect(isTransientProviderError(Object.assign(new Error("permanent"), { status }))).toBe(false);
  });

  it("retries transient failures with bounded attempts and returns the successful result", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error("still busy"), { status: 429 }))
      .mockResolvedValueOnce("complete");
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withTransientProviderRetry(operation, { sleep })).resolves.toBe("complete");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry permanent provider errors", async () => {
    const error = Object.assign(new Error("invalid"), { status: 400 });
    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withTransientProviderRetry(operation, { sleep })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
