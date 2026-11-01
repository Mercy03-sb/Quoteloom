import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  size?: "md" | "sm";
};

export function Button({ variant = "primary", size = "md", className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={cx("btn", `btn-${variant}`, size === "sm" && "btn-sm", className)} {...rest} />;
}
