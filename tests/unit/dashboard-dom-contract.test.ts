import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Dashboard DOM Contract", () => {
  it("keeps all required getElementById targets present in public/index.html", () => {
    const appSource = readFileSync(resolve(process.cwd(), "public/app.js"), "utf8");
    const htmlSource = readFileSync(resolve(process.cwd(), "public/index.html"), "utf8");

    const htmlIds = new Set(
      Array.from(htmlSource.matchAll(/id="([^"]+)"/g), (match) => match[1])
    );

    const requiredIds = new Set(
      Array.from(
        appSource.matchAll(/getElementById\((['"])([^'"]+)\1\)\s*(\?\.|\.)/g),
        (match) => ({ id: match[2], accessor: match[3] })
      )
        .filter((match) => match.accessor === ".")
        .map((match) => match.id)
    );

    const missingIds = Array.from(requiredIds).filter((id) => !htmlIds.has(id));

    expect(missingIds).toEqual([]);
  });

  it("keeps every sidebar nav target aligned with a concrete dashboard view", () => {
    const htmlSource = readFileSync(resolve(process.cwd(), "public/index.html"), "utf8");

    const htmlIds = new Set(
      Array.from(htmlSource.matchAll(/id="([^"]+)"/g), (match) => match[1])
    );
    const navViews = Array.from(
      htmlSource.matchAll(/data-view="([^"]+)"/g),
      (match) => match[1]
    );

    const missingViews = navViews.filter((view) => !htmlIds.has(`${view}-view`));

    expect(missingViews).toEqual([]);
  });
});
