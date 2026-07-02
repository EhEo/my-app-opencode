import type { FileKind } from "../../lib/fileKind";
import { ImageViewer } from "./ImageViewer";
import { PdfViewer } from "./PdfViewer";
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
  if (kind === "docx" || kind === "xlsx" || kind === "pptx") {
    return (
      <UnsupportedViewer
        path={path}
        message={`${kind.toUpperCase()} 뷰어는 아직 준비 중입니다. OS 앱으로 열 수 있어요.`}
      />
    );
  }
  return <UnsupportedViewer path={path} message="이 파일은 미리보기를 지원하지 않습니다." />;
}
