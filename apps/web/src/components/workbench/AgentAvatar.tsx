import {
  agentAvatarShapes as shapes,
  agentIconPaths,
  agentForeground,
} from "@t3tools/shared/agentAvatar";
import { useRef, useState, useEffect } from "react";
import type { AgentAvatar as Avatar } from "@t3tools/contracts";
import type { AgentProfile } from "./workbenchPreferences";
const icons = agentIconPaths;
export function AgentAvatar({
  agent,
  size = 48,
}: {
  agent: Pick<AgentProfile, "name" | "color" | "avatar">;
  size?: number;
}) {
  const avatar = agent.avatar;
  const iconPath = icons[(avatar?.icon ?? "bot") as keyof typeof icons] ?? icons.bot;
  return (
    <span data-wb-avatar="" style={{ width: size, height: size }} aria-hidden="true">
      {avatar?.kind === "image" && avatar.image ? (
        <img src={avatar.image} alt="" />
      ) : (
        <>
          <svg viewBox="0 0 64 64" focusable="false">
            <path fill={avatar?.color ?? agent.color} d={shapes[avatar?.shape ?? "squircle"]} />
            {avatar?.kind === "bot" && (
              <g fill={agentForeground(avatar.color)} transform="rotate(-17 32 32)">
                <rect x="22" y="23" width="6" height="15" rx="3" />
                <rect x="36" y="23" width="6" height="15" rx="3" />
              </g>
            )}
            {avatar?.kind === "icon" && (
              <g
                transform="translate(17 17) scale(1.25)"
                stroke={agentForeground(avatar.color)}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              >
                <path d={iconPath} />
              </g>
            )}
          </svg>
          {!avatar || avatar.kind === "initials" ? (
            <b style={{ color: agentForeground(avatar?.color ?? agent.color) }}>
              {agent.name.slice(0, 2).toUpperCase()}
            </b>
          ) : null}
        </>
      )}
    </span>
  );
}
export function AgentAvatarEditor({
  agent,
  onChange,
}: {
  agent: AgentProfile;
  onChange: (avatar: Avatar) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<ImageBitmap | null>(null);
  useEffect(() => () => source?.close(), [source]);
  const [zoom, setZoom] = useState(1);
  const [x, setX] = useState(50);
  const [y, setY] = useState(50);
  const [error, setError] = useState("");
  const avatar = agent.avatar ?? {
    kind: "initials" as const,
    shape: "squircle" as const,
    color: agent.color,
    icon: "bot",
    image: null,
  };
  const crop = (image: ImageBitmap, z: number, cx: number, cy: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image editing is unavailable.");
    const edge = Math.min(image.width, image.height) / z;
    context.drawImage(
      image,
      ((image.width - edge) * cx) / 100,
      ((image.height - edge) * cy) / 100,
      edge,
      edge,
      0,
      0,
      256,
      256,
    );
    onChange({ ...avatar, kind: "image", image: canvas.toDataURL("image/png") });
  };
  return (
    <fieldset data-wb-avatar-editor="">
      <legend>Agent Appearance</legend>
      <AgentAvatar agent={agent} size={72} />
      <label>
        Style
        <select
          value={avatar.kind}
          onChange={(e) => onChange({ ...avatar, kind: e.target.value as Avatar["kind"] })}
        >
          <option value="bot">Bot Face</option>
          <option value="initials">Initials</option>
          <option value="icon">Icon</option>
          <option value="image" disabled={!avatar.image}>
            Custom Image
          </option>
        </select>
      </label>
      <label>
        Shape
        <select
          value={avatar.shape}
          onChange={(e) => onChange({ ...avatar, shape: e.target.value as Avatar["shape"] })}
        >
          {Object.keys(shapes).map((s) => (
            <option key={s} value={s}>
              {s[0]!.toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Color
        <input
          type="color"
          value={avatar.color}
          onChange={(e) => onChange({ ...avatar, color: e.target.value })}
        />
      </label>
      {avatar.kind === "icon" && (
        <label>
          Icon
          <select
            value={avatar.icon}
            onChange={(e) => onChange({ ...avatar, icon: e.target.value })}
          >
            {Object.keys(icons).map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
      )}
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        aria-label="Agent Avatar Image"
        onChange={async (e) => {
          const imageFile = e.target.files?.[0];
          e.target.value = "";
          if (!imageFile) return;
          setError("");
          try {
            if (
              imageFile.size > 5 * 1024 * 1024 ||
              !["image/png", "image/jpeg", "image/webp"].includes(imageFile.type)
            )
              throw new Error("Choose a PNG, JPEG, or WebP image under 5 MB.");
            const image = await createImageBitmap(imageFile);
            source?.close();
            setSource(image);
            setZoom(1);
            setX(50);
            setY(50);
            crop(image, 1, 50, 50);
          } catch (e) {
            setError(e instanceof Error ? e.message : "Could not open this image.");
          }
        }}
      />
      <button type="button" onClick={() => file.current?.click()}>
        Upload Image
      </button>
      <button
        type="button"
        onClick={() => {
          source?.close();
          setSource(null);
          onChange({ ...avatar, kind: "bot", image: null, imageRef: null });
        }}
      >
        Reset Image
      </button>
      {source && (
        <>
          <label>
            Zoom
            <input
              type="range"
              min="1"
              max="3"
              step="0.05"
              value={zoom}
              onChange={(e) => {
                const value = Number(e.target.value);
                setZoom(value);
                crop(source, value, x, y);
              }}
            />
          </label>
          <label>
            Horizontal Crop
            <input
              type="range"
              value={x}
              onChange={(e) => {
                const value = Number(e.target.value);
                setX(value);
                crop(source, zoom, value, y);
              }}
            />
          </label>
          <label>
            Vertical Crop
            <input
              type="range"
              value={y}
              onChange={(e) => {
                const value = Number(e.target.value);
                setY(value);
                crop(source, zoom, x, value);
              }}
            />
          </label>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
