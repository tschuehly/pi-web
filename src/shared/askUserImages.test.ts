import { describe, expect, it } from "vitest";
import { parseAskUserSubmissionImages } from "./askUserImages.js";

const image = (data: string) => [{ target: { kind: "note" }, mimeType: "image/png", data }];

describe("parseAskUserSubmissionImages", () => {
  it("accepts only non-empty canonical base64, as the host's closeAsk does", () => {
    for (const data of ["AAAA", "AA==", "AAA=", "iVBORw0KGgo="]) expect(parseAskUserSubmissionImages(image(data))[0]?.data).toBe(data);
    // "AB==" and "AAB=" decode, but leave padding bits set: not canonical.
    for (const data of ["", "AB==", "AAB=", "A===", "AA=A", "AAA", "AA-_"]) {
      expect(() => parseAskUserSubmissionImages(image(data)), data).toThrow("image 1 is not valid base64");
    }
  });
});
