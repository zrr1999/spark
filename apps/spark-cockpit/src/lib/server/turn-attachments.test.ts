import { describe, expect, it } from "vitest";
import {
  TurnAttachmentValidationError,
  attachmentPrompt,
  turnAttachmentsFromFormData,
} from "./turn-attachments";

describe("Cockpit turn attachments", () => {
  it("materializes browser files into bounded protocol attachments", async () => {
    const formData = new FormData();
    formData.append(
      "attachments",
      new File([new Uint8Array([1, 2, 3])], "../shot.png", { type: "image/png" }),
    );
    formData.append("attachments", new File(["hello"], "notes.txt", { type: "text/plain" }));
    formData.append("attachments", new File([], "empty.txt", { type: "text/plain" }));

    const attachments = await turnAttachmentsFromFormData(formData);

    expect(attachments).toEqual([
      {
        kind: "image",
        name: "_shot.png",
        mediaType: "image/png",
        size: 3,
        data: "AQID",
      },
      {
        kind: "file",
        name: "notes.txt",
        mediaType: "text/plain",
        size: 5,
        data: "aGVsbG8=",
      },
      {
        kind: "file",
        name: "empty.txt",
        mediaType: "text/plain",
        size: 0,
        data: "",
      },
    ]);
    expect(attachmentPrompt("Please inspect", attachments, { image: "Image", file: "File" })).toBe(
      "Please inspect\n\n[Image: _shot.png]\n\n[File: notes.txt]\n\n[File: empty.txt]",
    );
  });

  it("rejects an oversized file before reading its bytes", async () => {
    const formData = new FormData();
    formData.append("attachments", new File([new Uint8Array(6 * 1024 * 1024 + 1)], "huge.bin"));

    await expect(turnAttachmentsFromFormData(formData)).rejects.toMatchObject({
      code: "file_size",
      fileName: "huge.bin",
    } satisfies Partial<TurnAttachmentValidationError>);
  });
});
