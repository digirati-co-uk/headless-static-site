import { useState } from "react";

export function JsonPanel({
  title,
  value,
  href,
  filename = "data.json",
}: {
  title: string;
  value: any;
  href?: string | null;
  filename?: string;
}) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const json = JSON.stringify(value, null, 2) ?? "null";

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setFeedback("Copied");
    } catch {
      setFeedback("Copy failed");
    }
    window.setTimeout(() => setFeedback(null), 2000);
  };

  const downloadJson = () => {
    const objectUrl = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    }
  };

  return (
    <details className="bg-white border border-gray-200 rounded-xl mb-3 p-3">
      <summary className="cursor-pointer font-semibold">
        <span>{title}</span>
        {href ? (
          <a
            className="ml-2 text-xs font-normal text-blue-700 underline"
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            Open file
          </a>
        ) : null}
        <span className="ml-3 inline-flex items-center gap-2 text-xs font-normal">
          <button
            type="button"
            className="text-blue-700 underline"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void copyJson();
            }}
          >
            Copy JSON
          </button>
          <button
            type="button"
            className="text-blue-700 underline"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              downloadJson();
            }}
          >
            Download
          </button>
          {feedback ? <span role="status">{feedback}</span> : null}
        </span>
      </summary>
      <pre className="mt-3 bg-slate-50 border border-gray-200 rounded-lg p-3 overflow-auto text-xs">
        {json}
      </pre>
    </details>
  );
}
