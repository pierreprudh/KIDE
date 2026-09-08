import pdfLogo from "./assets/document-apps/pdf.webp";
import excelLogo from "./assets/document-apps/excel.webp";
import powerpointLogo from "./assets/document-apps/powerpoint.webp";
import wordLogo from "./assets/document-apps/word.webp";

const APP_LOGOS: Record<string, string> = {
  pdf: pdfLogo,
  xls: excelLogo, xlsx: excelLogo, xlsm: excelLogo, xlsb: excelLogo,
  ppt: powerpointLogo, pptx: powerpointLogo, pptm: powerpointLogo,
  pps: powerpointLogo, ppsx: powerpointLogo,
  doc: wordLogo, docx: wordLogo, docm: wordLogo,
};

export function documentAppLogo(path: string): string | undefined {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? APP_LOGOS[name.slice(dot + 1).toLowerCase()] : undefined;
}
