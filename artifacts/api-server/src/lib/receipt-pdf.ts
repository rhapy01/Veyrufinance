export type ReceiptLine = { label: string; value: string };

function printable(value: string): string {
  return value.normalize("NFKD").replace(/[^\x20-\x7E]/g, "?").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function createReceiptPdf(receipt: { title: string; subtitle: string; lines: ReceiptLine[]; footer: string }): Buffer {
  const pages: string[][] = [];
  let commands: string[] = [];
  let y = 615;
  const startPage = (continued: boolean) => {
    commands = [
      "0.09 0.31 0.24 rg 0 705 612 87 re f",
      "BT /F1 24 Tf 1 1 1 rg 48 750 Td (VEYRA FINANCE) Tj ET",
      `BT /F1 10 Tf 0.88 0.94 0.89 rg 48 728 Td (${printable(continued ? `${receipt.subtitle} · CONTINUED` : receipt.subtitle)}) Tj ET`,
      `BT /F1 19 Tf 0.15 0.19 0.27 rg 48 667 Td (${printable(receipt.title)}) Tj ET`,
      "0.88 0.87 0.82 RG 48 648 m 564 648 l S",
    ];
    y = 615;
  };
  const finishPage = () => {
    commands.push("0.88 0.87 0.82 RG 48 75 m 564 75 l S");
    commands.push(`BT /F1 9 Tf 0.42 0.46 0.48 rg 48 55 Td (${printable(receipt.footer)}) Tj ET`);
    pages.push(commands);
  };
  startPage(false);
  for (const line of receipt.lines) {
    const wrapped = line.value.match(/.{1,68}(?:\s|$)|\S{1,68}/g) ?? [line.value];
    if (y < 130) { finishPage(); startPage(true); }
    commands.push(`BT /F1 9 Tf 0.42 0.46 0.48 rg 48 ${y} Td (${printable(line.label.toUpperCase())}) Tj ET`);
    y -= 18;
    for (const part of wrapped) {
      if (y < 100) { finishPage(); startPage(true); }
      commands.push(`BT /F1 12 Tf 0.15 0.19 0.27 rg 48 ${y} Td (${printable(part.trim())}) Tj ET`);
      y -= 18;
    }
    y -= 12;
  }
  finishPage();
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  const pageIds: number[] = [];
  for (const pageCommands of pages) {
    const pageId = objects.length + 1;
    const streamId = pageId + 1;
    const stream = `${pageCommands.join("\n")}\n`;
    pageIds.push(pageId);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}
