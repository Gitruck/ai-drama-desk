import { useRef, useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from "react";

type AsyncButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  onClick: (event: MouseEvent<HTMLButtonElement>) => unknown | Promise<unknown>;
  pendingText?: ReactNode;
};

/**
 * 所有会发请求或执行耗时工作的按钮都走这一层。
 * ref 是同步门闩：React 还没来得及重绘 disabled 时，第二次点击也进不来。
 */
export function AsyncButton({ onClick, pendingText = "处理中…", disabled, children, ...props }: AsyncButtonProps) {
  const locked = useRef(false);
  const [pending, setPending] = useState(false);

  const handleClick = async (event: MouseEvent<HTMLButtonElement>) => {
    if (locked.current) return;
    locked.current = true;
    setPending(true);
    try {
      await onClick(event);
    } finally {
      locked.current = false;
      setPending(false);
    }
  };

  return (
    <button {...props} disabled={disabled || pending} aria-busy={pending || undefined} onClick={handleClick}>
      {pending ? pendingText : children}
    </button>
  );
}
