import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import { askAssistant } from "./ai.js";

export type SlackFileRef = {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  url_private?: string;
  url_private_download?: string;
};

export function hasReadableSlackFiles(files?: SlackFileRef[]): boolean {
  return Boolean(files?.some((file) => isReadableFile(file)));
}

export function formatSlackFileMentions(files?: SlackFileRef[]): string {
  const readable = (files ?? []).filter((file) => file.name || file.title);
  if (!readable.length) return "";
  return readable.map((file) => `[attached file: ${file.name ?? file.title}]`).join(" ");
}

export async function answerSlackFileQuestion(
  files: SlackFileRef[],
  question: string,
  conversationId: string,
  token: string
): Promise<string | undefined> {
  const readable = files.filter((file) => isReadableFile(file));
  if (!readable.length) return undefined;

  const file = readable[0];
  const extracted = await readSlackFileText(file, token);
  if (!extracted.text) {
    return `I found ${file.name ?? file.title ?? "the uploaded file"}, but I could not read it: ${extracted.error ?? "no text returned"}`;
  }

  const instruction = isSummarizeQuestion(question)
    ? "Summarize this uploaded file. Include the key points, important action items, and anything risky or unclear."
    : `Answer this question from the uploaded file only: ${question}`;

  const answer = await askAssistant(
    `${conversationId}:slack-file:${file.id ?? file.name ?? "upload"}`,
    instruction,
    [
      `Uploaded file: ${file.name ?? file.title ?? "file"}`,
      `File type: ${file.mimetype ?? file.filetype ?? "unknown"}`,
      `Extracted text:\n${extracted.text.slice(0, 18000)}`
    ].join("\n\n")
  );

  return [`*From uploaded file - ${file.name ?? file.title ?? "file"}*`, answer].join("\n");
}

async function readSlackFileText(file: SlackFileRef, token: string): Promise<{ text?: string; error?: string }> {
  const url = file.url_private_download ?? file.url_private;
  if (!url) return { error: "Slack did not provide a downloadable file URL." };

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    return { error: `Slack file download failed (${response.status})` };
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const name = (file.name ?? file.title ?? "").toLowerCase();
  const mime = (file.mimetype ?? "").toLowerCase();
  const type = (file.filetype ?? "").toLowerCase();

  try {
    if (mime.includes("pdf") || type === "pdf" || name.endsWith(".pdf")) {
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        return { text: result.text?.trim() };
      } finally {
        await parser.destroy();
      }
    }

    if (mime.includes("wordprocessingml") || type === "docx" || name.endsWith(".docx")) {
      const result = await mammoth.extractRawText({ buffer });
      return { text: result.value.trim() };
    }

    if (mime.includes("spreadsheet") || type === "xlsx" || name.endsWith(".xlsx")) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
      return { text: workbook.worksheets.map((sheet) => {
        const rows: string[] = [];
        sheet.eachRow((row) => {
          const values = Array.isArray(row.values) ? row.values.slice(1) : [];
          rows.push(values.map((value) => cellText(value)).join(","));
        });
        return `Sheet: ${sheet.name}\n${rows.join("\n")}`;
      }).join("\n\n").trim() };
    }

    if (mime.includes("csv") || type === "csv" || name.endsWith(".csv") || mime.startsWith("text/")) {
      return { text: buffer.toString("utf8").trim() };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  return { error: "Supported uploads are PDF, DOCX, XLSX, CSV, and text files." };
}

function isReadableFile(file: SlackFileRef): boolean {
  const name = (file.name ?? file.title ?? "").toLowerCase();
  const mime = (file.mimetype ?? "").toLowerCase();
  const type = (file.filetype ?? "").toLowerCase();
  return Boolean(file.url_private_download ?? file.url_private) && (
    mime.includes("pdf") ||
    mime.includes("wordprocessingml") ||
    mime.includes("spreadsheet") ||
    mime.includes("csv") ||
    mime.startsWith("text/") ||
    ["pdf", "docx", "xlsx", "csv", "txt"].includes(type) ||
    /\.(pdf|docx|xlsx|csv|txt)$/i.test(name)
  );
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const rich = value as { text?: string; result?: unknown; formula?: string; hyperlink?: string };
    if (rich.text) return rich.text;
    if (rich.result !== undefined) return cellText(rich.result);
    if (rich.formula) return rich.formula;
    if (rich.hyperlink) return rich.hyperlink;
  }
  return String(value).replace(/\s+/g, " ").trim();
}

function isSummarizeQuestion(text: string): boolean {
  return !text.trim() || /\b(summarize|summary|recap|read|review|what'?s in|what is in)\b/i.test(text);
}
