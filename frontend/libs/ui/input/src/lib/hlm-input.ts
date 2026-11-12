import { Directive } from "@angular/core";
import { BrnFieldControlDescribedBy } from "@spartan-ng/brain/field";
import { BrnInput } from "@spartan-ng/brain/input";
import { classes } from "@spartan-ng/helm/utils";

@Directive({
  selector: "[hlmInput]",
  hostDirectives: [
    { directive: BrnInput, inputs: ["id", "forceInvalid"] },
    BrnFieldControlDescribedBy,
  ],
  host: { "data-slot": "input" },
})
export class HlmInput {
  constructor() {
    // The field of round 14: `.field` in
    // styles.css -- glass, no border, white with dark words on a television
    // while it is typed into. Invalid keeps helm's red edge.
    classes(
      () =>
        "field data-[matches-spartan-invalid=true]:outline-2 data-[matches-spartan-invalid=true]:outline-destructive file:h-7 file:text-sm file:font-medium file:text-foreground file:inline-flex file:border-0 file:bg-transparent disabled:pointer-events-none disabled:cursor-not-allowed",
    );
  }
}
