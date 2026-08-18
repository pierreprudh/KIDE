// Dragging a conversation out of the rail.
//
// The rail is a list of conversations; Focus's canvas can hold two of them.
// Drag-and-drop is the one gesture that says *which half* — a click can only
// mean "the usual place". So the rail marks its rows draggable, the canvas
// marks its halves as drop targets, and this module owns the one thing they
// have to agree on: the payload.
//
// A private MIME type (rather than `text/plain`) is deliberate. It keeps a
// dragged conversation from dropping into every textarea in the app as a raw
// id, and it lets a drop target ask "is this one of mine?" during `dragover`,
// where the payload itself is unreadable — the browser exposes `types` but not
// the data until the drop.

export const CONVERSATION_MIME = "application/x-klide-conversation";

/** Mark a drag as carrying this conversation. */
export function setConversationDrag(transfer: DataTransfer, conversationId: string) {
  transfer.setData(CONVERSATION_MIME, conversationId);
  transfer.effectAllowed = "copy";
}

/** True while the pointer carries a conversation — readable mid-drag. */
export function isConversationDrag(transfer: DataTransfer | null): boolean {
  return transfer ? Array.from(transfer.types).includes(CONVERSATION_MIME) : false;
}

/** The dropped conversation's id, or null when the drop was something else. */
export function readConversationDrag(transfer: DataTransfer | null): string | null {
  const id = transfer?.getData(CONVERSATION_MIME) ?? "";
  return id || null;
}
