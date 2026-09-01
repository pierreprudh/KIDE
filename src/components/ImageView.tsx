type Props = {
  /** `data:<mime>;base64,…` URI of the image to render. */
  src: string;
  /** File path, used for the alt text. */
  name: string;
};

/**
 * Read-only image preview shown in the editor pane when an image file is opened
 * from the explorer. The picture is centred and contained on a neutral
 * backdrop; anything larger than the pane scales down to fit, and the pane
 * scrolls if it can't. Quiet by design — the tab bar already names the file.
 */
export function ImageView({ src, name }: Props) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "grid",
        // Definite tracks, not auto ones: the image's percentage max-height
        // resolves against the track, and an auto track sized by a tall
        // picture would resolve it against the picture — which is how an
        // oversized screenshot kept its natural height instead of fitting.
        gridTemplateColumns: "minmax(0, 1fr)",
        gridTemplateRows: "minmax(0, 1fr)",
        placeItems: "center",
        overflow: "auto",
        padding: 24,
        background: "var(--bg)",
      }}
    >
      <img
        src={src}
        alt={name}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          borderRadius: 6,
          border: "1px solid var(--border)",
        }}
      />
    </div>
  );
}
