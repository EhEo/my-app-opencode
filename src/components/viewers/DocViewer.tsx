import type { FileKind } from "../../lib/fileKind";
import { ImageViewer } from "./ImageViewer";
import { PdfViewer } from "./PdfViewer";
import { DocxViewer } from "./DocxViewer";
import { XlsxViewer } from "./XlsxViewer";
import { PptxViewer } from "./PptxViewer";
import { UnsupportedViewer } from "./UnsupportedViewer";
import { openInOsApp } from "./openExternally";

export function DocViewer({
  path,
  kind,
}: {
  path: string;
  kind: FileKind;
}): React.JSX.Element {
  let body: React.JSX.Element;
  // Office/PDF/image viewers get a floating "열기" button to launch the file
  // in the Windows-associated app. Unsupported/binary has its own button.
  let showOpen = true;
  if (kind === "image") {
    body = <ImageViewer path={path} />;
  } else if (kind === "pdf") {
    body = <PdfViewer path={path} />;
  } else if (kind === "docx") {
    body = <DocxViewer path={path} />;
  } else if (kind === "xlsx") {
    body = <XlsxViewer path={path} />;
  } else if (kind === "pptx") {
    body = <PptxViewer path={path} />;
  } else {
    body = (
      <UnsupportedViewer
        path={path}
        message="이 파일은 미리보기를 지원하지 않습니다."
      />
    );
    showOpen = false;
  }
  return (
    <div className="doc-viewer">
      {body}
      {showOpen ? (
        <button
          type="button"
          className="doc-viewer__open-btn editor-pane__preview-toggle toolbar__btn"
          onClick={() => void openInOsApp(path)}
          title="Windows에 연결된 프로그램으로 열기"
        >
          열기
        </button>
      ) : null}
    </div>
  );
}
