import type { Components } from "react-markdown";

// Shared react-markdown renderers that apply the .chat-md__* styling. Callers
// supply their own `a` renderer, because link behavior differs: the chat opens
// links in a new tab, while the editor preview routes web URLs to the OS
// browser and local links to an editor tab.
export const baseMarkdownComponents: Components = {
  p: ({ children }) => <p className="chat-md__p">{children}</p>,
  h1: ({ children }) => <h1 className="chat-md__h1">{children}</h1>,
  h2: ({ children }) => <h2 className="chat-md__h2">{children}</h2>,
  h3: ({ children }) => <h3 className="chat-md__h3">{children}</h3>,
  h4: ({ children }) => <h4 className="chat-md__h4">{children}</h4>,
  ul: ({ children }) => <ul className="chat-md__ul">{children}</ul>,
  ol: ({ children }) => <ol className="chat-md__ol">{children}</ol>,
  li: ({ children }) => <li className="chat-md__li">{children}</li>,
  code: ({ className, children, node, ...rest }) => {
    void node;
    const isBlock = typeof className === "string" && className.includes("language-");
    return (
      <code
        className={isBlock ? "chat-md__code-block" : "chat-md__inline-code"}
        {...rest}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => <pre className="chat-md__pre">{children}</pre>,
  blockquote: ({ children }) => (
    <blockquote className="chat-md__blockquote">{children}</blockquote>
  ),
  strong: ({ children }) => <strong className="chat-md__strong">{children}</strong>,
  em: ({ children }) => <em className="chat-md__em">{children}</em>,
  hr: () => <hr className="chat-md__hr" />,
};
