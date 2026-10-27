import { useSyncExternalStore } from "react";
import { workshop } from "./runtime";
export const useWorkshop = () =>
  useSyncExternalStore(
    workshop.subscribe,
    workshop.getSnapshot,
    workshop.getSnapshot,
  );
export const useWorkshopData = () =>
  useSyncExternalStore(
    workshop.subscribe,
    workshop.getDataSnapshot,
    workshop.getDataSnapshot,
  );
