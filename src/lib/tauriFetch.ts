import { invoke, Channel } from "@tauri-apps/api/core";

interface ProxyEventHeaders {
  type: "headers";
  status: number;
  headers: Record<string, string>;
}
interface ProxyEventChunk {
  type: "chunk";
  data: number[];
}
interface ProxyEventDone {
  type: "done";
}
interface ProxyEventError {
  type: "error";
  message: string;
}
type ProxyEvent =
  | ProxyEventHeaders
  | ProxyEventChunk
  | ProxyEventDone
  | ProxyEventError;

export function createTauriFetch(): typeof fetch {
  return async (input, init) => {
    const url =
      input instanceof URL
        ? input.href
        : typeof input === "string"
          ? input
          : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headerMap: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        headerMap[k] = v;
      });
    }
    let body: string | undefined;
    if (typeof init?.body === "string") {
      body = init.body;
    } else if (init?.body === null || init?.body === undefined) {
      body = undefined;
    } else {
      throw new TypeError("tauriFetch 지원 본문은 string 본문만입니다");
    }
    const streamId = crypto.randomUUID();

    const channel = new Channel<ProxyEvent>();
    return await new Promise<Response>((resolve, reject) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
        cancel() {
          void invoke("proxy_abort", { streamId });
        },
      });
      let started = false;
      channel.onmessage = (msg: ProxyEvent): void => {
        switch (msg.type) {
          case "headers": {
            if (started) return;
            started = true;
            const respHeaders = new Headers(msg.headers);
            resolve(
              new Response(stream, {
                status: msg.status,
                headers: respHeaders,
              }),
            );
            break;
          }
          case "chunk": {
            controller?.enqueue(new Uint8Array(msg.data));
            break;
          }
          case "done": {
            controller?.close();
            break;
          }
          case "error": {
            if (!started) {
              reject(new Error(msg.message));
            } else {
              controller?.error(new Error(msg.message));
            }
            break;
          }
        }
      };
      init?.signal?.addEventListener("abort", () => {
        void invoke("proxy_abort", { streamId });
      });
      void invoke("proxy_request", {
        method,
        url,
        headers: headerMap,
        body,
        streamId,
        onEvent: channel,
      }).catch((e: unknown) => {
        if (!started) {
          const message = e instanceof Error ? e.message : String(e);
          reject(new Error(message));
        }
      });
    });
  };
}