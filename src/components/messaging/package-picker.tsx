"use client";

import { useEffect, useRef, useState } from "react";
import { Package as PackageIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { api } from "@/lib/client";
import { cn, formatINR } from "@/lib/utils";
import { formatPackageForEmail, type PackageDetails } from "@/lib/packages";

interface PackageOption extends PackageDetails {
  id: string;
  isActive: boolean;
}

/**
 * "Package" button + popover, mirrors TemplatePicker's interaction. Unlike a
 * template (a complete canned message that replaces the compose box),
 * picking a package hands the caller a formatted text block to append —
 * you usually write your own line first ("here's what we offer:") then
 * attach the details, rather than starting from them.
 */
export function PackagePicker({
  onSelect,
  openUpward = false,
  align = "right",
}: {
  onSelect: (formatted: string) => void;
  openUpward?: boolean;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [packages, setPackages] = useState<PackageOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  function openPicker() {
    setOpen((o) => !o);
    if (packages === null) {
      setLoading(true);
      api
        .get<PackageOption[]>("/api/packages")
        .then(setPackages)
        .catch(() => setPackages([]))
        .finally(() => setLoading(false));
    }
  }

  function pick(p: PackageOption) {
    onSelect(formatPackageForEmail(p));
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <Button type="button" variant="outline" size="icon" onClick={openPicker} title="Insert package details">
        <PackageIcon className="h-4 w-4" />
      </Button>

      {open && (
        <div
          className={cn(
            "absolute z-20 w-72 rounded-md border border-border bg-popover shadow-lg",
            align === "left" ? "left-0" : "right-0",
            openUpward ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          <div className="max-h-72 overflow-y-auto py-1">
            {loading && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            )}
            {!loading && packages?.length === 0 && (
              <p className="px-3 py-3 text-sm text-muted-foreground">No packages yet.</p>
            )}
            {!loading &&
              packages?.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => pick(p)}
                  className="block w-full px-3 py-2 text-left text-sm transition-colors hover:bg-secondary"
                >
                  <span className="block truncate font-medium text-foreground">{p.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {formatINR(p.basePriceINR)} · {p.durationDays}d · {p.category}
                  </span>
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
