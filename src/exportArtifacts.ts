import ExcelJS from "exceljs";
import { Document, Packer, Paragraph, TextRun } from "docx";
import PDFDocument from "pdfkit";
import type { ClickUpHealthTask } from "./clickup.js";

export type ExportFormat = "xlsx" | "docx" | "pdf";

export type ExportArtifact = {
  filename: string;
  title: string;
  mimeType: string;
  buffer: Buffer;
};

export async function createClickUpExportArtifact(input: {
  title: string;
  tasks: ClickUpHealthTask[];
  format: ExportFormat;
  rangeLabel?: string;
}): Promise<ExportArtifact> {
  if (input.format === "xlsx") return createClickUpXlsx(input.title, input.tasks, input.rangeLabel);
  if (input.format === "docx") return createClickUpDocx(input.title, input.tasks, input.rangeLabel);
  return createClickUpPdf(input.title, input.tasks, input.rangeLabel);
}

export async function createTextExportArtifact(input: {
  title: string;
  text: string;
  format: ExportFormat;
}): Promise<ExportArtifact> {
  if (input.format === "docx") {
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({ children: [new TextRun({ text: input.title, bold: true, size: 28 })] }),
          ...input.text.split(/\r?\n/).map((line) => new Paragraph(line.replace(/\*/g, "")))
        ]
      }]
    });
    return {
      filename: `${safeFilename(input.title)}.docx`,
      title: input.title,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: await Packer.toBuffer(doc)
    };
  }

  if (input.format === "pdf") {
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ margin: 42, size: "A4" });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.fontSize(16).text(input.title.replace(/\*/g, ""), { underline: true });
      doc.moveDown();
      doc.fontSize(9).text(input.text.replace(/\*/g, ""), { width: 510 });
      doc.end();
    });
    return {
      filename: `${safeFilename(input.title)}.pdf`,
      title: input.title,
      mimeType: "application/pdf",
      buffer
    };
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Report");
  sheet.columns = [{ header: "Report", key: "line", width: 120 }];
  sheet.addRows(input.text.split(/\r?\n/).map((line) => ({ line: line.replace(/\*/g, "") })));
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    filename: `${safeFilename(input.title)}.xlsx`,
    title: input.title,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer
  };
}

function taskRows(tasks: ClickUpHealthTask[]) {
  return tasks.map((task) => ({
    id: task.id,
    name: task.name,
    status: task.status ?? "",
    dueDate: task.dueDate ? formatDate(task.dueDate) : "",
    updatedAt: task.updatedAt ? formatDate(task.updatedAt) : "",
    timeEstimate: task.timeEstimate ? formatDuration(task.timeEstimate) : "",
    assignees: task.assignees.join(", "),
    priority: task.priority ?? "",
    listName: task.listName ?? "",
    url: task.url ?? `https://app.clickup.com/t/${task.id}`
  }));
}

async function createClickUpXlsx(title: string, tasks: ClickUpHealthTask[], rangeLabel?: string): Promise<ExportArtifact> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Viktor";
  workbook.created = new Date();

  const summary = workbook.addWorksheet("Summary");
  summary.addRows([
    ["Report", title],
    ["Date scope", rangeLabel ?? "not specified"],
    ["Tasks", tasks.length],
    ["Not completed", tasks.filter((task) => !isCompleteStatus(task.status)).length],
    ["Overdue", tasks.filter((task) => task.dueDate && task.dueDate < Date.now() && !isCompleteStatus(task.status)).length]
  ]);
  summary.columns = [{ width: 24 }, { width: 80 }];
  summary.getColumn(1).font = { bold: true };

  const byStatus = statusCounts(tasks);
  summary.addRow([]);
  summary.addRow(["Status", "Tasks"]);
  for (const [status, count] of byStatus) summary.addRow([status, count]);

  const sheet = workbook.addWorksheet("Tasks");
  sheet.columns = [
    { header: "Task ID", key: "id", width: 18 },
    { header: "Name", key: "name", width: 60 },
    { header: "Status", key: "status", width: 20 },
    { header: "Due", key: "dueDate", width: 14 },
    { header: "Updated", key: "updatedAt", width: 14 },
    { header: "Estimate", key: "timeEstimate", width: 12 },
    { header: "Assignees", key: "assignees", width: 36 },
    { header: "Priority", key: "priority", width: 14 },
    { header: "List", key: "listName", width: 32 },
    { header: "URL", key: "url", width: 60 }
  ];
  sheet.addRows(taskRows(tasks));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = "A1:J1";

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    filename: `${safeFilename(title)}.xlsx`,
    title,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer
  };
}

async function createClickUpDocx(title: string, tasks: ClickUpHealthTask[], rangeLabel?: string): Promise<ExportArtifact> {
  const rows = taskRows(tasks).slice(0, 200);
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 28 })] }),
        new Paragraph(`Date scope: ${rangeLabel ?? "not specified"}`),
        new Paragraph(`Tasks: ${tasks.length}`),
        new Paragraph(`Not completed: ${tasks.filter((task) => !isCompleteStatus(task.status)).length}`),
        new Paragraph(""),
        ...rows.flatMap((task, index) => [
          new Paragraph({ children: [new TextRun({ text: `${index + 1}. ${task.name}`, bold: true })] }),
          new Paragraph(`${task.status || "No status"} | due ${task.dueDate || "not set"} | ${task.assignees || "unassigned"} | ${task.listName || "no list"}`),
          new Paragraph(task.url)
        ])
      ]
    }]
  });
  return {
    filename: `${safeFilename(title)}.docx`,
    title,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: await Packer.toBuffer(doc)
  };
}

async function createClickUpPdf(title: string, tasks: ClickUpHealthTask[], rangeLabel?: string): Promise<ExportArtifact> {
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 42, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(16).text(title, { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).text(`Date scope: ${rangeLabel ?? "not specified"}`);
    doc.text(`Tasks: ${tasks.length}`);
    doc.text(`Not completed: ${tasks.filter((task) => !isCompleteStatus(task.status)).length}`);
    doc.moveDown();

    for (const [index, task] of taskRows(tasks).slice(0, 160).entries()) {
      doc.fontSize(9).text(`${index + 1}. ${task.name}`, { continued: false });
      doc.fontSize(8).text(`${task.status || "No status"} | due ${task.dueDate || "not set"} | ${task.assignees || "unassigned"} | ${task.listName || "no list"}`);
      doc.fillColor("blue").text(task.url, { link: task.url, underline: true });
      doc.fillColor("black").moveDown(0.35);
    }

    doc.end();
  });

  return {
    filename: `${safeFilename(title)}.pdf`,
    title,
    mimeType: "application/pdf",
    buffer
  };
}

function statusCounts(tasks: ClickUpHealthTask[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const status = task.status?.trim() || "No status";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function isCompleteStatus(status?: string): boolean {
  return /^(complete|completed|closed|done)$/i.test((status ?? "").trim());
}

function formatDate(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function formatDuration(milliseconds: number): string {
  const hours = milliseconds / (60 * 60 * 1000);
  if (hours < 1) return `${Math.round(milliseconds / (60 * 1000))}m`;
  if (Number.isInteger(hours)) return `${hours}h`;
  return `${Math.round(hours * 10) / 10}h`;
}

function safeFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "viktor-export";
}
