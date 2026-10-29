import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { Command } from './CommandPalette';

type Setter = (owner: string, commands: readonly Command[] | null) => void;

// Two contexts: pages that add commands hold the setter, which never changes, so they do not
// render again when another page's commands change.
const SetterContext = createContext<Setter | null>(null);
const CommandsContext = createContext<readonly Command[]>([]);

/**
 * Commands that pages add to the palette while they show (AGL-018 (1)): the ticket view adds
 * its actions, for example. The app's own commands come first; these follow, by owner.
 */
export function PaletteCommandsProvider({ children }: { children: ReactNode }) {
  const [owned, setOwned] = useState<ReadonlyMap<string, readonly Command[]>>(new Map());
  const set = useCallback<Setter>((owner, commands) => {
    setOwned((current) => {
      if (commands === null && !current.has(owner)) return current;
      const next = new Map(current);
      if (commands === null) next.delete(owner);
      else next.set(owner, commands);
      return next;
    });
  }, []);
  const commands = useMemo(() => [...owned.values()].flat(), [owned]);
  return (
    <SetterContext.Provider value={set}>
      <CommandsContext.Provider value={commands}>{children}</CommandsContext.Provider>
    </SetterContext.Provider>
  );
}

/** The commands pages added, for the palette. */
export function useRegisteredCommands(): readonly Command[] {
  return useContext(CommandsContext);
}

/**
 * Adds `commands` to the palette while the calling component is mounted. Outside a provider
 * (stories, tests of one page) it does nothing.
 */
export function usePaletteCommands(owner: string, commands: readonly Command[]) {
  const set = useContext(SetterContext);
  useEffect(() => {
    set?.(owner, commands);
  }, [set, owner, commands]);
  useEffect(() => () => set?.(owner, null), [set, owner]);
}
