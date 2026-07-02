import type { FileKind } from "../../lib/fileKind";
import { ImageViewer } from "./ImageViewer";
import { PdfViewer } from "./PdfViewer";
import { DocxViewer } from "./DocxViewer";
import { XlsxViewer } from "./XlsxViewer";
import { PptxViewer } from "./PptxViewer";
import { UnsupportedViewer } from "./UnsupportedViewer";

export function DocViewer({
  path,
  kind,
}: {
  path: string;
  kind: FileKind;
}): React.JSX.Element {
  if (kind === "image") return <ImageViewer path={path} />;
  if (kind === "pdf") return <PdfViewer path={path} />;
  if (kind === "docx") return <DocxViewer path={path} />;
  if (kind === "xlsx") return <XlsxViewer path={path} />;
  if (kind === "pptx") return <PptxViewer path={path} />;
  return <UnsupportedViewer path={path} message="이 파일은 미리보기를 지원하지 않습니다." />;
}
