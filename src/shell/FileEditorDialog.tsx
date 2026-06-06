import { createEffect, createSignal, Show } from 'solid-js';

export type ActiveFileEditor = {
  title: string;
  filePath: string;
  displayPath: string;
  content: string;
  language?: string;
};

export function FileEditorDialog(props: {
  editor: ActiveFileEditor | null;
  width: number;
  height: number;
  onSave: (content: string) => { ok: true } | { ok: false; error: string };
  onCancel: () => void;
}) {
  let textareaRef: any;
  const [error, setError] = createSignal<string | null>(null);
  const [draftContent, setDraftContent] = createSignal<string | null>(null);

  createEffect(() => {
    const editor = props.editor;
    setError(null);
    setDraftContent(editor?.content ?? null);
  });

  const dialogWidth = () => Math.max(52, Math.min(110, Math.floor(props.width * 0.74)));
  const dialogHeight = () => Math.max(16, Math.min(34, Math.floor(props.height * 0.72)));
  const left = () => Math.max(1, Math.floor((props.width - dialogWidth()) / 2));
  const top = () => Math.max(1, Math.floor((props.height - dialogHeight()) / 2));
  const editorHeight = () => Math.max(6, dialogHeight() - 8);

  const save = () => {
    const content = String(textareaRef?.plainText ?? draftContent() ?? props.editor?.content ?? '');
    const result = props.onSave(content);
    if (!result.ok) setError(result.error);
  };

  return (
    <Show when={props.editor}>
      {(editor) => (
        <box
          position="absolute"
          left={left()}
          top={top()}
          width={dialogWidth()}
          height={dialogHeight()}
          zIndex={30}
          border
          borderStyle="rounded"
          borderColor="#5DADE2"
          backgroundColor="#111318"
          padding={1}
          flexDirection="column"
          overflow="hidden"
        >
          <text height={1} fg="#FBBF24">{editor().title}</text>
          <text height={1} fg="#7F8C8D">{editor().displayPath}</text>
          <box
            height={editorHeight()}
            flexDirection="column"
            border
            borderStyle="single"
            borderColor="#4B5563"
            backgroundColor="#0B0D12"
            overflow="hidden"
          >
            <textarea
              ref={textareaRef}
              focused
              height={editorHeight() - 2}
              width={dialogWidth() - 6}
              initialValue={editor().content}
              wrapMode="word"
              keyBindings={[{ name: 's', ctrl: true, action: 'submit' }]}
              onSubmit={save}
              onContentChange={setDraftContent}
            />
          </box>
          <Show when={error()}>
            {(message) => <text height={1} fg="#F87171">{message()}</text>}
          </Show>
          <box height={1} flexDirection="row">
            <text fg="#111318" bg="#8BD5CA"> Save Ctrl+S </text>
            <text fg="#7F8C8D">  </text>
            <text fg="#D6DEE8" bg="#4B5563"> Cancel Esc </text>
          </box>
        </box>
      )}
    </Show>
  );
}
