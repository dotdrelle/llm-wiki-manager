/** @jsxImportSource @opentui/solid */
import { For, Show } from 'solid-js';

export function SlashDialog(props: { context: any }) {
  return (
    <Show when={props.context}>
      {(context) => (
        <box
          position="absolute"
          left={1}
          bottom={4}
          width="64%"
          height={Math.min(16, context().items.length + 5)}
          zIndex={10}
          border
          borderStyle="rounded"
          borderColor="#5DADE2"
          backgroundColor="#111318"
          padding={1}
          flexDirection="column"
        >
          <text fg="#7F8C8D">Completions</text>
          <For each={context().items}>
            {(item: any, index) => (
              <text
                height={1}
                fg={index() === context().selected ? '#111318' : '#D6DEE8'}
                bg={index() === context().selected ? '#8BD5CA' : '#111318'}
              >
                {item.value.padEnd(16, ' ')} {item.description}
              </text>
            )}
          </For>
          <text fg="#7F8C8D">[up/down navigate  Tab complete  Enter confirm  Esc clear]</text>
        </box>
      )}
    </Show>
  );
}
