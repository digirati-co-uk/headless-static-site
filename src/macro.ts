export async function macro() {
  const output = await Bun.build({
    entrypoints: ["./src/dev/client.ts"],
    sourcemap: "inline",
    target: "browser",
  });

  const client = await output.outputs[0].text();

  const index = await Bun.file(
    import.meta.resolveSync("./dev/index.html"),
  ).text();
  const clover = await Bun.file(
    import.meta.resolveSync("./dev/clover.html"),
  ).text();
  const explorer = await Bun.file(
    import.meta.resolveSync("./dev/explorer.html"),
  ).text();
  const editor = await Bun.file(
    import.meta.resolveSync("./dev/editor.html"),
  ).text();

  return {
    client,
    index,
    clover,
    explorer,
    editor,
  };
}
