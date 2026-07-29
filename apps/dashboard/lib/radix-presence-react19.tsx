"use client";

import * as React from "react";
import {
  shouldFinishUnmountWithoutNode,
  type PresenceState,
} from "./radix-presence-state";

/**
 * React 19 compatibility fork of @radix-ui/react-presence 1.1.7 (MIT).
 * Keep the public exports aligned with Radix and remove the Vite alias once
 * https://github.com/radix-ui/primitives/issues/3664 is resolved upstream.
 */
interface PresenceProps {
  children: React.ReactElement | ((props: { present: boolean }) => React.ReactElement);
  present: boolean;
}

type PresenceEvent = "MOUNT" | "UNMOUNT" | "ANIMATION_OUT" | "ANIMATION_END";

const transitions: Record<PresenceState, Partial<Record<PresenceEvent, PresenceState>>> = {
  mounted: {
    UNMOUNT: "unmounted",
    ANIMATION_OUT: "unmountSuspended",
  },
  unmountSuspended: {
    MOUNT: "mounted",
    ANIMATION_END: "unmounted",
  },
  unmounted: {
    MOUNT: "mounted",
  },
};

function useStateMachine(initialState: PresenceState) {
  return React.useReducer(
    (state: PresenceState, event: PresenceEvent): PresenceState => transitions[state][event] ?? state,
    initialState,
  );
}

const useLayoutEffect = typeof document === "undefined" ? React.useEffect : React.useLayoutEffect;

const Presence: React.FC<PresenceProps> = ({ present, children }) => {
  const presence = usePresence(present);
  const child = (
    typeof children === "function"
      ? children({ present: presence.isPresent })
      : React.Children.only(children)
  ) as React.ReactElement<{ ref?: React.Ref<HTMLElement> }>;
  const ref = useStableComposedRefs(presence.ref, getElementRef(child));
  const forceMount = typeof children === "function";

  return forceMount || presence.isPresent ? React.cloneElement(child, { ref }) : null;
};

Presence.displayName = "Presence";

function usePresence(present: boolean) {
  const [node, setNode] = React.useState<HTMLElement>();
  const stylesRef = React.useRef<CSSStyleDeclaration | null>(null);
  const prevPresentRef = React.useRef(present);
  const prevAnimationNameRef = React.useRef("none");
  const mountAnimationNameRef = React.useRef<string | undefined>(undefined);
  const [state, send] = useStateMachine(present ? "mounted" : "unmounted");

  React.useEffect(() => {
    if (state === "mounted") {
      prevAnimationNameRef.current =
        mountAnimationNameRef.current ?? getAnimationName(stylesRef.current);
      mountAnimationNameRef.current = undefined;
    } else {
      prevAnimationNameRef.current = "none";
    }
  }, [state]);

  useLayoutEffect(() => {
    const styles = stylesRef.current;
    const wasPresent = prevPresentRef.current;

    if (wasPresent !== present) {
      const prevAnimationName = prevAnimationNameRef.current;
      const currentAnimationName = getAnimationName(styles);

      if (present) {
        mountAnimationNameRef.current = currentAnimationName;
        send("MOUNT");
      } else if (currentAnimationName === "none" || styles?.display === "none") {
        send("UNMOUNT");
      } else if (wasPresent && prevAnimationName !== currentAnimationName) {
        send("ANIMATION_OUT");
      } else {
        send("UNMOUNT");
      }

      prevPresentRef.current = present;
    }
  }, [present, send]);

  useLayoutEffect(() => {
    if (!node) {
      if (shouldFinishUnmountWithoutNode(state)) send("ANIMATION_END");
      return;
    }

    let timeoutId: number | undefined;
    const ownerWindow = node.ownerDocument.defaultView ?? window;
    const handleAnimationEnd = (event: AnimationEvent) => {
      const currentAnimationName = getAnimationName(stylesRef.current);
      const isCurrentAnimation = currentAnimationName.includes(CSS.escape(event.animationName));

      if (event.target === node && isCurrentAnimation) {
        send("ANIMATION_END");
        if (!prevPresentRef.current) {
          const currentFillMode = node.style.animationFillMode;
          node.style.animationFillMode = "forwards";
          timeoutId = ownerWindow.setTimeout(() => {
            if (node.style.animationFillMode === "forwards") {
              node.style.animationFillMode = currentFillMode;
            }
          });
        }
      }
    };
    const handleAnimationStart = (event: AnimationEvent) => {
      if (event.target === node) {
        prevAnimationNameRef.current = getAnimationName(stylesRef.current);
      }
    };

    node.addEventListener("animationstart", handleAnimationStart);
    node.addEventListener("animationcancel", handleAnimationEnd);
    node.addEventListener("animationend", handleAnimationEnd);

    return () => {
      if (timeoutId !== undefined) ownerWindow.clearTimeout(timeoutId);
      node.removeEventListener("animationstart", handleAnimationStart);
      node.removeEventListener("animationcancel", handleAnimationEnd);
      node.removeEventListener("animationend", handleAnimationEnd);
    };
  }, [node, send, state]);

  return {
    isPresent: state === "mounted" || state === "unmountSuspended",
    ref: React.useCallback((nextNode: HTMLElement | null) => {
      if (nextNode) {
        const styles = getComputedStyle(nextNode);
        stylesRef.current = styles;
        mountAnimationNameRef.current = getAnimationName(styles);
      } else {
        stylesRef.current = null;
      }
      setNode(nextNode ?? undefined);
    }, []),
  };
}

type PossibleRef<T> = React.Ref<T> | undefined;

function setRef<T>(ref: PossibleRef<T>, value: T | null) {
  if (typeof ref === "function") return ref(value);
  if (ref !== null && ref !== undefined) ref.current = value;
}

function useStableComposedRefs<T>(...refs: PossibleRef<T>[]): React.RefCallback<T> {
  const refsRef = React.useRef(refs);
  refsRef.current = refs;

  return React.useCallback((node: T | null) => {
    const currentRefs = refsRef.current;
    let hasCleanup = false;
    const cleanups = currentRefs.map((ref) => {
      const cleanup = setRef(ref, node);
      if (!hasCleanup && typeof cleanup === "function") hasCleanup = true;
      return cleanup;
    });

    if (hasCleanup) {
      return () => {
        for (let i = 0; i < cleanups.length; i += 1) {
          const cleanup = cleanups[i];
          if (typeof cleanup === "function") cleanup();
          else setRef(currentRefs[i], null);
        }
      };
    }
  }, []);
}

function getAnimationName(styles: CSSStyleDeclaration | null): string {
  return styles?.animationName || "none";
}

function getElementRef(element: React.ReactElement<{ ref?: React.Ref<unknown> }>) {
  let getter = Object.getOwnPropertyDescriptor(element.props, "ref")?.get;
  let mayWarn = getter && "isReactWarning" in getter && getter.isReactWarning;
  if (mayWarn) return (element as React.ReactElement & { ref?: React.Ref<unknown> }).ref;

  getter = Object.getOwnPropertyDescriptor(element, "ref")?.get;
  mayWarn = getter && "isReactWarning" in getter && getter.isReactWarning;
  if (mayWarn) return element.props.ref;

  return element.props.ref || (element as React.ReactElement & { ref?: React.Ref<unknown> }).ref;
}

const Root = Presence;

export { Presence, Root };
export type { PresenceProps };
