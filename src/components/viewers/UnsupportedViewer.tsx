import { openInOsApp } from "./openExternally";

export function UnsupportedViewer({
  path,
  message,
}: {
  path: string;
  message: string;
}): React.JSX.Element {
  return (
    <div className="doc-viewer__unsupported">
      <p>{message}</p>
      <button type="button" className="toolbar__btn" onClick={() => void openInOsApp(path)}>
        OS 기본 앱으로 열기
      </button>
    </div>
  );
}
