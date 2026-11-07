// Rust naming shared by the tree-sitter lane and the SCIP (rust-analyzer) lane.
//
// Both lanes hang impl-block members off the impl's SELF type, so
// `impl<T: Default> Circle<T> { fn unit }` and `impl Greeter for &Person { fn greet }`
// land at `file.rs::Circle::unit` / `file.rs::Person::greet`. They only agree
// on the id if they reduce the self-type text the same way, so that reduction
// lives here, once.

/**
 * Reduce an impl self-type as written (`Circle<T>`, `&'a mut Person`,
 * `crate::shapes::Circle<f64>`, `dyn Greeter`) to the bare type name the
 * declaration itself carries (`Circle`, `Person`, `Circle`, `Greeter`).
 */
export function rustSelfTypeName(text: string): string {
  let t = text.trim();
  // Leading reference / pointer / lifetime / dyn / impl qualifiers.
  for (;;) {
    const before = t;
    t = t.replace(/^&\s*/, "")
      .replace(/^\*\s*(const|mut)\s+/, "")
      .replace(/^'[A-Za-z_][A-Za-z0-9_]*\s+/, "")
      .replace(/^(mut|dyn|impl)\s+/, "")
      .trim();
    if (t === before) break;
  }
  const lt = t.indexOf("<");
  if (lt >= 0) t = t.slice(0, lt);
  const parts = t.split("::");
  return (parts[parts.length - 1] ?? t).trim();
}
