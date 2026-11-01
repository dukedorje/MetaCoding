import { beforeAll, describe, expect, test } from "bun:test";

import { makeParser, type TsParser } from "./parser.ts";
import { extractStructural } from "./structural.ts";

const opts = {
  filePath: "src/A",
  branch: "main",
  repo: "naoms",
};

let js: TsParser;
let rust: TsParser;
let kotlin: TsParser;
let swift: TsParser;

beforeAll(async () => {
  js = await makeParser("javascript");
  rust = await makeParser("rust");
  kotlin = await makeParser("kotlin");
  swift = await makeParser("swift");
});

function names(grammar: "javascript" | "rust" | "kotlin" | "swift", parser: TsParser, src: string) {
  const tree = parser.parse(src);
  const ex = extractStructural(tree, { ...opts, grammar, filePath: `src/A.${grammar}` });
  tree.delete();
  return ex.symbols.filter((s) => s.kind !== "file").map((s) => `${s.kind}:${s.short_name}`);
}

describe("structural extractors for naoms languages", () => {
  test("javascript class, method, field, function", () => {
    expect(names("javascript", js, `
      export class Foo {
        bar = 1
        method() { return 1 }
      }
      function baz() {}
    `)).toEqual(["class:Foo", "field:bar", "method:method", "function:baz"]);
  });

  test("rust struct, impl method, trait, enum, fn", () => {
    expect(names("rust", rust, `
      pub struct Foo { x: i32 }
      impl Foo { pub fn new() {} fn m(&self) {} }
      pub trait T { fn f(&self); }
      pub enum E { A }
      pub fn top() {}
    `)).toEqual([
      "class:Foo", "field:x", "method:new", "method:m",
      "interface:T", "method:f",
      "enum:E", "field:A",
      "function:top",
    ]);
  });

  test("kotlin class, constructor param, method, interface", () => {
    expect(names("kotlin", kotlin, `
      interface I { fun f() }
      class Foo(val x: Int) { fun bar(): Int { return x } }
    `)).toEqual(["interface:I", "method:f", "class:Foo", "field:x", "method:bar"]);
  });

  test("swift class, property, method, struct, protocol, function", () => {
    expect(names("swift", swift, `
      class Foo { var x: Int = 0; func bar() {} }
      struct S { func m() {} }
      protocol P { func f() }
      func top() {}
    `)).toEqual([
      "class:Foo", "field:x", "method:bar",
      "class:S", "method:m",
      "interface:P", "method:f",
      "function:top",
    ]);
  });
});
