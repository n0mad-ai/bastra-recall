import type { PowerlineColors } from "./themes";
import type { PowerlineConfig } from "./config/loader";
import type { PowerlineSymbols } from "./segments";
import type { PowerlineTheme } from "./powerline-theme";

import { extractBgToFg } from "./utils/colors";
import { getColorSupport } from "./utils/color-support";
import { visibleLength } from "./utils/terminal";

export interface RenderedSegment {
  type: string;
  text: string;
  bgColor: string;
  fgColor: string;
  bold?: boolean;
}

/**
 * Line layout for PowerlineRenderer (#1039): measures rendered segments,
 * packs them into lines that fit the terminal width (auto-wrap), and
 * assembles each line as ANSI text with the separators of the style.
 */
export class PowerlineLayout {
  constructor(
    private readonly config: PowerlineConfig,
    private readonly symbols: PowerlineSymbols,
    private readonly theme: PowerlineTheme,
  ) {}

  /** Splits one configured line into as many output lines as the width needs. */
  wrapSegments(
    renderedSegments: RenderedSegment[],
    terminalWidth: number | null,
    colors: PowerlineColors,
  ): string[] {
    const outputLines: string[] = [];

    if (!terminalWidth || terminalWidth <= 0) {
      outputLines.push(this.buildLineFromSegments(renderedSegments, colors));
      return outputLines;
    }

    let currentLineSegments: RenderedSegment[] = [];
    let currentLineWidth = 0;

    for (const segment of renderedSegments) {
      const segmentWidth = this.calculateSegmentWidth(
        segment,
        currentLineSegments.length === 0,
      );

      if (
        currentLineSegments.length > 0 &&
        currentLineWidth + segmentWidth > terminalWidth
      ) {
        outputLines.push(
          this.buildLineFromSegments(currentLineSegments, colors),
        );
        currentLineSegments = [];
        currentLineWidth = 0;
      }

      currentLineSegments.push(segment);
      currentLineWidth += segmentWidth;
    }

    if (currentLineSegments.length > 0) {
      outputLines.push(
        this.buildLineFromSegments(currentLineSegments, colors),
      );
    }

    return outputLines;
  }

  private calculateSegmentWidth(
    segment: RenderedSegment,
    isFirst: boolean,
  ): number {
    const isCapsuleStyle = this.config.display.style === "capsule";
    const textWidth = visibleLength(segment.text);
    const padding = this.config.display.padding ?? 1;
    const paddingWidth = padding * 2;

    if (isCapsuleStyle) {
      const capsuleOverhead = 2 + paddingWidth + (isFirst ? 0 : 1);
      return textWidth + capsuleOverhead;
    }

    const powerlineOverhead = 1 + paddingWidth;
    return textWidth + powerlineOverhead;
  }

  buildLineFromSegments(
    segments: RenderedSegment[],
    colors: PowerlineColors,
  ): string {
    const isCapsuleStyle = this.config.display.style === "capsule";
    let line = colors.reset;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (!segment) continue;

      const isFirst = i === 0;
      const isLast = i === segments.length - 1;
      const nextSegment = !isLast ? segments[i + 1] : null;

      if (isCapsuleStyle && !isFirst) {
        line += " ";
      }

      const bold =
        segment.bold ?? this.theme.getSegmentBoldFlag(segment.type, colors);

      line += this.formatSegment(
        segment.bgColor,
        segment.fgColor,
        segment.text,
        nextSegment?.bgColor,
        colors,
        bold,
      );
    }

    return line;
  }

  private formatSegment(
    bgColor: string,
    fgColor: string,
    text: string,
    nextBgColor: string | undefined,
    colors: PowerlineColors,
    bold: boolean,
  ): string {
    const isCapsuleStyle = this.config.display.style === "capsule";
    const padding = " ".repeat(this.config.display.padding ?? 1);
    const useBold = bold && colors.reset !== "";
    const boldOn = useBold ? "\x1b[1m" : "";
    const boldOff = useBold ? "\x1b[22m" : "";

    if (isCapsuleStyle) {
      const colorMode = this.config.display.colorCompatibility || "auto";
      const colorSupport = colorMode === "auto" ? getColorSupport() : colorMode;
      const isBasicMode = colorSupport === "ansi";

      const capFgColor = extractBgToFg(bgColor, isBasicMode);

      const leftCap = `${capFgColor}${this.symbols.left}${colors.reset}`;

      const content = `${bgColor}${fgColor}${boldOn}${padding}${text}${padding}${boldOff}${colors.reset}`;

      const rightCap = `${capFgColor}${this.symbols.right}${colors.reset}`;

      return `${leftCap}${content}${rightCap}`;
    }

    let output = `${bgColor}${fgColor}${boldOn}${padding}${text}${padding}${boldOff}`;

    const colorMode = this.config.display.colorCompatibility || "auto";
    const colorSupport = colorMode === "auto" ? getColorSupport() : colorMode;
    const isBasicMode = colorSupport === "ansi";

    if (nextBgColor) {
      const arrowFgColor = extractBgToFg(bgColor, isBasicMode);
      output += `${colors.reset}${nextBgColor}${arrowFgColor}${this.symbols.right}`;
    } else {
      output += `${colors.reset}${extractBgToFg(bgColor, isBasicMode)}${this.symbols.right}${colors.reset}`;
    }

    return output;
  }
}
