(() => {
  "use strict";

  const PAGE_WIDTH = 842;
  const PAGE_HEIGHT = 595;
  const MARGIN = 32;
  const CONTENT_WIDTH = PAGE_WIDTH - (MARGIN * 2);
  const COLORS = {
    ink: [0.08, 0.09, 0.08],
    muted: [0.38, 0.4, 0.38],
    line: [0.84, 0.84, 0.8],
    paper: [0.98, 0.98, 0.96],
    panel: [0.94, 0.94, 0.9],
    amber: [0.85, 0.64, 0.25],
    green: [0.25, 0.52, 0.34],
    white: [1, 1, 1]
  };

  function safe(value) {
    return String(value ?? "")
      .replace(/\u00a3/g, "GBP ")
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/\u2192/g, "->")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x20-\x7E]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function literal(value) {
    return safe(value).replace(/([\\()])/g, "\\$1");
  }

  function color(value) {
    return value.map((item) => Number(item).toFixed(3)).join(" ");
  }

  function wrap(value, width, size = 8, maximumLines = 3) {
    const text = safe(value) || "-";
    const limit = Math.max(5, Math.floor(width / (size * 0.52)));
    const words = text.split(" ");
    const lines = [];
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (next.length <= limit) {
        current = next;
        continue;
      }
      if (current) lines.push(current);
      current = word.length > limit ? word.slice(0, limit) : word;
      if (lines.length >= maximumLines) break;
    }
    if (current && lines.length < maximumLines) lines.push(current);
    if (words.join(" ").length > lines.join(" ").length && lines.length) {
      lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, Math.max(1, limit - 3))}...`;
    }
    return lines.length ? lines : ["-"];
  }

  class PdfLayout {
    constructor(title, rangeLabel) {
      this.title = title;
      this.rangeLabel = rangeLabel;
      this.pages = [];
      this.page = null;
      this.y = 0;
      this.newPage();
    }

    newPage() {
      this.page = [];
      this.pages.push(this.page);
      this.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, COLORS.paper);
      this.rect(0, 0, PAGE_WIDTH, 13, COLORS.amber);
      this.text("ACE", MARGIN, 36, 18, true, COLORS.ink);
      this.text("OTS SUPPLIER", MARGIN + 48, 35, 9, true, COLORS.amber);
      this.text(this.title, MARGIN, 58, 15, true, COLORS.ink);
      this.text(this.rangeLabel, MARGIN, 73, 8, false, COLORS.muted);
      this.y = 94;
    }

    ensure(height) {
      if (this.y + height > PAGE_HEIGHT - 35) this.newPage();
    }

    rect(x, top, width, height, fill) {
      this.page.push(`q ${color(fill)} rg ${x.toFixed(2)} ${(PAGE_HEIGHT - top - height).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f Q`);
    }

    line(x1, top1, x2, top2, stroke = COLORS.line, width = 0.5) {
      this.page.push(`q ${color(stroke)} RG ${width} w ${x1.toFixed(2)} ${(PAGE_HEIGHT - top1).toFixed(2)} m ${x2.toFixed(2)} ${(PAGE_HEIGHT - top2).toFixed(2)} l S Q`);
    }

    text(value, x, top, size = 8, bold = false, fill = COLORS.ink) {
      this.page.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${color(fill)} rg 1 0 0 1 ${x.toFixed(2)} ${(PAGE_HEIGHT - top).toFixed(2)} Tm (${literal(value)}) Tj ET`);
    }

    section(title) {
      this.ensure(34);
      this.rect(MARGIN, this.y, CONTENT_WIDTH, 23, COLORS.ink);
      this.text(title, MARGIN + 10, this.y + 15, 9, true, COLORS.white);
      this.y += 29;
    }

    summary(metrics) {
      const gap = 7;
      const width = (CONTENT_WIDTH - (gap * (metrics.length - 1))) / metrics.length;
      this.ensure(58);
      metrics.forEach((metric, index) => {
        const x = MARGIN + (index * (width + gap));
        this.rect(x, this.y, width, 50, COLORS.panel);
        this.rect(x, this.y, 3, 50, index === metrics.length - 1 ? COLORS.green : COLORS.amber);
        this.text(metric.value, x + 11, this.y + 22, 15, true, COLORS.ink);
        this.text(metric.label, x + 11, this.y + 38, 7, false, COLORS.muted);
      });
      this.y += 61;
    }

    table(columns, rows, emptyMessage) {
      const drawHeader = () => {
        this.ensure(24);
        this.rect(MARGIN, this.y, CONTENT_WIDTH, 20, COLORS.panel);
        let x = MARGIN;
        for (const column of columns) {
          this.text(column.label, x + 5, this.y + 13, 7, true, COLORS.muted);
          x += column.width;
        }
        this.y += 20;
      };
      drawHeader();
      if (!rows.length) {
        this.ensure(30);
        this.text(emptyMessage, MARGIN + 6, this.y + 18, 8, false, COLORS.muted);
        this.y += 28;
        return;
      }
      rows.forEach((row, index) => {
        const cells = columns.map((column) => wrap(row[column.key], column.width - 10, column.size || 7.5, column.lines || 3));
        const rowHeight = Math.max(23, Math.max(...cells.map((lines) => lines.length)) * 9 + 9);
        if (this.y + rowHeight > PAGE_HEIGHT - 35) {
          this.newPage();
          drawHeader();
        }
        if (index % 2 === 1) this.rect(MARGIN, this.y, CONTENT_WIDTH, rowHeight, [0.965, 0.965, 0.94]);
        let x = MARGIN;
        cells.forEach((lines, cellIndex) => {
          lines.forEach((line, lineIndex) => this.text(line, x + 5, this.y + 13 + (lineIndex * 9), columns[cellIndex].size || 7.5, false, COLORS.ink));
          x += columns[cellIndex].width;
        });
        this.line(MARGIN, this.y + rowHeight, MARGIN + CONTENT_WIDTH, this.y + rowHeight);
        this.y += rowHeight;
      });
      this.y += 8;
    }

    bytes() {
      const total = this.pages.length;
      this.pages.forEach((page, index) => {
        page.push(`BT /F1 7 Tf ${color(COLORS.muted)} rg 1 0 0 1 ${MARGIN} 18 Tm (Generated by ACE OTS Supplier) Tj ET`);
        page.push(`BT /F1 7 Tf ${color(COLORS.muted)} rg 1 0 0 1 ${PAGE_WIDTH - 82} 18 Tm (Page ${index + 1} of ${total}) Tj ET`);
      });

      const objects = [];
      objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
      objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
      objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";
      const kids = [];
      this.pages.forEach((commands, index) => {
        const pageId = 5 + (index * 2);
        const streamId = pageId + 1;
        const stream = commands.join("\n");
        kids.push(`${pageId} 0 R`);
        objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamId} 0 R >>`;
        objects[streamId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
      });
      objects[2] = `<< /Type /Pages /Count ${this.pages.length} /Kids [${kids.join(" ")}] >>`;

      let pdf = "%PDF-1.4\n%ACE\n";
      const offsets = [0];
      for (let index = 1; index < objects.length; index += 1) {
        offsets[index] = pdf.length;
        pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`;
      }
      const xref = pdf.length;
      pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
      for (let index = 1; index < objects.length; index += 1) pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
      pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
      return pdf;
    }
  }

  function download(report) {
    const pdf = new PdfLayout("Operations Report", `${report.from} to ${report.to} | Generated ${report.generatedAt}`);
    pdf.summary(report.metrics);
    pdf.section("SOURCE RIDES");
    pdf.table([
      { key: "source", label: "Source", width: 58 },
      { key: "created", label: "Received UK", width: 92 },
      { key: "reference", label: "Reference", width: 112 },
      { key: "pickup", label: "Pickup", width: 155 },
      { key: "dropOff", label: "Drop-off", width: 155 },
      { key: "vehicle", label: "Vehicle", width: 105 },
      { key: "milesFare", label: "Miles / fare", width: 101 }
    ], report.rides, "No retained OTS or WhatsApp rides were received in this range.");
    pdf.section("BID ACTIVITY");
    pdf.table([
      { key: "created", label: "Created UK", width: 92 },
      { key: "type", label: "Type", width: 54 },
      { key: "reference", label: "Reference", width: 118 },
      { key: "route", label: "Route", width: 235 },
      { key: "amount", label: "Amount", width: 58 },
      { key: "status", label: "Status", width: 82 },
      { key: "reason", label: "Reason / result", width: 139 }
    ], report.bids, "No bids were created in this range.");
    pdf.section("LINKER SUGGESTIONS");
    pdf.table([
      { key: "created", label: "Created UK", width: 92 },
      { key: "references", label: "Booked / candidate", width: 145 },
      { key: "route", label: "Matched routes", width: 245 },
      { key: "deadhead", label: "Deadhead", width: 83 },
      { key: "score", label: "Score", width: 45 },
      { key: "reason", label: "Why suggested", width: 168 }
    ], report.links, "No strict Linker suggestions were created in this range.");

    const blob = new Blob([pdf.bytes()], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ace-ots-supplier-report-${report.from}-to-${report.to}.pdf`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.OtsSupplierReport = { download };
})();
