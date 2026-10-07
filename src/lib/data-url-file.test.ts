import { describe, it, expect } from "vitest";
import { dataUrlToFile } from "./data-url-file";

// 1×1 transparent PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

/**
 * A logo pasted with a copied signature arrives as a data: URI. Left in the
 * HTML it blew the footer's size limit, and the server sanitizer would have
 * stripped it anyway. The editor turns it back into a file and uploads it —
 * this is the conversion that makes that possible.
 */
describe("dataUrlToFile", () => {
  it("turns a pasted PNG data URI into an uploadable file", async () => {
    const f = dataUrlToFile(`data:image/png;base64,${PNG_B64}`, "Trē logo");
    expect(f).not.toBeNull();
    expect(f!.type).toBe("image/png");
    expect(f!.name).toMatch(/\.png$/);
    const bytes = new Uint8Array(await f!.arrayBuffer());
    // PNG signature
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("gives JPEGs a .jpg name", () => {
    const f = dataUrlToFile(`data:image/jpeg;base64,${PNG_B64}`, "photo");
    expect(f!.name).toMatch(/\.jpg$/);
  });

  it("tolerates whitespace inside the base64, as some clipboards wrap it", () => {
    const wrapped = PNG_B64.replace(/(.{20})/g, "$1\n");
    expect(dataUrlToFile(`data:image/png;base64,${wrapped}`, "x")).not.toBeNull();
  });

  it("refuses SVG, which Gmail and Outlook will not render inline", () => {
    expect(dataUrlToFile("data:image/svg+xml;base64,PHN2Zy8+", "x")).toBeNull();
  });

  it("refuses anything that is not a base64 image", () => {
    expect(dataUrlToFile("data:text/html;base64,PGI+aGk8L2I+", "x")).toBeNull();
    expect(dataUrlToFile("https://example.com/logo.png", "x")).toBeNull();
    expect(dataUrlToFile("data:image/png;base64,@@not-base64@@", "x")).toBeNull();
  });

  it("keeps a filename safe for the upload flow", () => {
    const f = dataUrlToFile(`data:image/png;base64,${PNG_B64}`, 'a "quoted"/../name');
    expect(f!.name).not.toMatch(/["/]/);
  });
});
