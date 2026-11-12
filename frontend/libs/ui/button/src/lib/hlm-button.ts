import { Directive, input, signal } from "@angular/core";
import { BrnButton } from "@spartan-ng/brain/button";
import { classes } from "@spartan-ng/helm/utils";
import { cva, type VariantProps } from "class-variance-authority";
import type { ClassValue } from "clsx";
import { injectBrnButtonConfig } from "./hlm-button.token";

/**
 * The button is the player's pill:
 * `.pill` and its modifiers in styles.css, under "The pieces". Glass at rest,
 * white when focused on a television, round when it has no word.
 *
 * - `primary`: the main action of a screen, solid on a phone and the desktop.
 *   On a television it is glass like the rest; focus is what marks it.
 * - `secondary` (the default): glass.
 * - `quiet`: no glass until a pointer or focus finds it.
 * - `destructive`: what cannot be undone -- a red icon, not a red pill.
 *
 * helm's own names (`default`, `outline`, `ghost`, `link`) are gone, so a
 * button cannot be written in the old look; `design-system.spec.ts` checks the
 * templates for them.
 */
export const buttonVariants = cva("pill", {
  variants: {
    variant: {
      primary: "pill-primary",
      secondary: "",
      quiet: "pill-quiet",
      destructive: "pill-destructive",
    },
    size: {
      default: "",
      sm: "pill-sm",
      xs: "pill-xs",
      lg: "",
      icon: "pill-round",
      "icon-sm": "pill-round pill-sm",
      "icon-xs": "pill-round pill-xs",
      "icon-lg": "pill-round",
    },
  },
  defaultVariants: {
    variant: "secondary",
    size: "default",
  },
});

export type ButtonVariants = VariantProps<typeof buttonVariants>;

@Directive({
  selector: "button[hlmBtn], a[hlmBtn]",
  exportAs: "hlmBtn",
  hostDirectives: [{ directive: BrnButton, inputs: ["disabled"] }],
  host: { "data-slot": "button" },
})
export class HlmButton {
  private readonly _config = injectBrnButtonConfig();

  private readonly _additionalClasses = signal<ClassValue>("");

  public readonly variant = input<ButtonVariants["variant"]>(
    this._config.variant,
  );

  public readonly size = input<ButtonVariants["size"]>(this._config.size);

  constructor() {
    classes(() => [
      buttonVariants({ variant: this.variant(), size: this.size() }),
      this._additionalClasses(),
    ]);
  }

  setClass(classes: string): void {
    this._additionalClasses.set(classes);
  }
}
