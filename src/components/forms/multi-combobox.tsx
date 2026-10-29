"use client";

import { useId, useState } from "react";
import { CheckIcon, ChevronsUpDownIcon, XIcon } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { Option } from "./chip-select";

/** Searchable multi-select for long lists (industries, countries). Selected values show as removable tags. */
export function MultiCombobox({
  id,
  options,
  value,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyText,
  invalid,
  describedBy,
}: {
  id?: string;
  options: Option[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const selected = new Set(value);
  const labelOf = new Map(options.map((option) => [option.value, option.label]));

  const toggle = (option: string) =>
    onChange(selected.has(option) ? value.filter((v) => v !== option) : [...value, option]);

  return (
    <div className="space-y-2.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            id={id}
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            className={cn(
              "flex h-10 w-full items-center justify-between rounded-lg border border-input bg-background px-3 text-left text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive",
              value.length === 0 && "text-muted-foreground",
            )}
          >
            {value.length === 0 ? placeholder : `${value.length} selected`}
            <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
          <Command>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList id={listId}>
              <CommandEmpty>{emptyText}</CommandEmpty>
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem key={option.value} value={option.label} onSelect={() => toggle(option.value)}>
                    <CheckIcon className={cn("text-primary", !selected.has(option.value) && "invisible")} />
                    {option.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Selected">
          {value.map((v) => (
            <li
              key={v}
              className="inline-flex items-center gap-1 rounded-md bg-secondary py-1 pr-1 pl-2.5 text-sm"
            >
              {labelOf.get(v) ?? v}
              <button
                type="button"
                onClick={() => toggle(v)}
                className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                aria-label={`Remove ${labelOf.get(v) ?? v}`}
              >
                <XIcon className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
