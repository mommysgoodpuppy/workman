import { walk } from "https://deno.land/std@0.208.0/fs/walk.ts";

async function combineMarkdownFiles() {
  const baseDir = "./";
  const outputFile = "canonical_full_generated.md";

  const files: string[] = [];

  // Collect all .md files except plan.md and README.md
  for await (const entry of walk(baseDir)) {
    if (
      entry.isFile &&
      entry.name.endsWith('.md') &&
      entry.name !== 'plan.md' &&
      entry.name !== 'README.md'
    ) {
      files.push(entry.path);
    }
  }

  // Sort files to maintain order
  files.sort();

  let combinedContent = '';

  // Read and concatenate content
  for (const file of files) {
    const content = await Deno.readTextFile(file);
    combinedContent += content + '\n\n';
  }

  // Write to output file
  await Deno.writeTextFile(outputFile, combinedContent);
  console.log(`Combined markdown written to ${outputFile}`);
}

// Run the script
if (import.meta.main) {
  await combineMarkdownFiles();
}
