import { Directive } from "@angular/core";
import { BrnLabel } from "@spartan-ng/brain/label";
import { classes } from "@spartan-ng/helm/utils";

@Directive({
  selector: "[hlmLabel]",
  hostDirectives: [{ directive: BrnLabel, inputs: ["id", "for"] }],
  host: { "data-slot": "label" },
})
export class HlmLabel {
  constructor() {
    // The name above a field (round 14): grey, sentence case -- `.field-label`.
    classes(
      () =>
        "field-label gap-2 leading-none flex items-center select-none group-data-[disabled=true]:opacity-50 group-data-[disabled=true]:pointer-events-none peer-disabled:opacity-50 peer-disabled:cursor-not-allowed",
    );
  }
}
