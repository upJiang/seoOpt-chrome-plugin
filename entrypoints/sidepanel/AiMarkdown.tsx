import ReactMarkdown from 'react-markdown';

export default function AiMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      skipHtml
      components={{
        a: ({ children, href }) => <span className="ai-link-text">{children}{href ? ` (${href})` : ''}</span>,
        img: ({ alt, src }) => <span className="ai-link-text">{alt || '图片'}{src ? ` (${src})` : ''}</span>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
