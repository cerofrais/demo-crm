import type { Config } from "tailwindcss";

/**
 * Trē Wellness design system.
 * Palette derived from the brand (olive / light green / black / white / grey).
 * Semantic tokens are CSS variables (see globals.css) so the theme is swappable;
 * the static `brand` scale is available for one-off accents.
 */
const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        // Hybrid: the live site's teal/sea-green family (understated), replacing
        // the original olive scale. See docs note in 12-… / brand audit.
        brand: {
          50: "#eef4f5",
          100: "#d8e8ea",
          200: "#b4d2d6",
          300: "#84b5bc",
          400: "#4f93a0",
          500: "#246a80", // primary teal (matches trewellness.in #246a80)
          600: "#1f5b6c",
          700: "#13484f", // deep teal (site #13484f)
          800: "#103a40",
          900: "#0e2f34", // ink teal
        },
        // Warm earthy neutrals lifted from the site for surfaces/accents.
        earth: {
          50: "#faf8f4",
          100: "#f3f1ec",
          200: "#e6e2da",
          300: "#dad6d0",
          400: "#c7b9a9",
          500: "#b7ada1",
          cream: "#f7f4c8",
          sage: "#41958b",
        },
        // Semantic tokens (HSL via CSS vars)
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar))",
          foreground: "hsl(var(--sidebar-foreground))",
          accent: "hsl(var(--sidebar-accent))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
        "slide-in-left": {
          from: { transform: "translateX(-100%)" },
          to: { transform: "translateX(0)" },
        },
        "slide-in-bottom": {
          from: { transform: "translateY(100%)" },
          to: { transform: "translateY(0)" },
        },
        "overlay-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "zoom-in": {
          from: { opacity: "0", transform: "scale(0.96)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.18s ease-out",
        "slide-in-right": "slide-in-right 0.22s ease-out",
        "slide-in-left": "slide-in-left 0.22s ease-out",
        "slide-in-bottom": "slide-in-bottom 0.24s ease-out",
        "overlay-in": "overlay-in 0.18s ease-out",
        "zoom-in": "zoom-in 0.16s ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
