/**
 * Shared toast plumbing. App mounts one <Toaster toasterId={APP_TOASTER_ID}>;
 * any feature dispatches through useAppToasts() (Fluent's controller is
 * context-free, keyed by id).
 *
 * `error` accepts an optional action rendered in the title's action slot via
 * ToastTrigger, so tapping it dismisses the toast — and, critically, that tap
 * is a USER GESTURE: the pattern exists for platform APIs (clipboard on
 * WKWebView/Safari) that reject programmatic calls without transient user
 * activation. Action toasts get a longer timeout so there is time to tap.
 */
import { useMemo } from 'react';
import {
  Link,
  Toast,
  ToastTitle,
  ToastTrigger,
  useToastController,
} from '@fluentui/react-components';

export const APP_TOASTER_ID = 'gretta-toaster';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface AppToasts {
  success: (message: string) => void;
  error: (message: string, action?: ToastAction) => void;
  info: (message: string) => void;
}

export function useAppToasts(): AppToasts {
  const { dispatchToast } = useToastController(APP_TOASTER_ID);
  return useMemo(
    () => ({
      success: (message) => {
        dispatchToast(
          <Toast>
            <ToastTitle>{message}</ToastTitle>
          </Toast>,
          { intent: 'success' },
        );
      },
      error: (message, action) => {
        if (action === undefined) {
          dispatchToast(
            <Toast>
              <ToastTitle>{message}</ToastTitle>
            </Toast>,
            { intent: 'error' },
          );
          return;
        }
        dispatchToast(
          <Toast>
            <ToastTitle
              action={
                <ToastTrigger>
                  <Link onClick={action.onClick}>{action.label}</Link>
                </ToastTrigger>
              }
            >
              {message}
            </ToastTitle>
          </Toast>,
          { intent: 'error', timeout: 8000 },
        );
      },
      info: (message) => {
        dispatchToast(
          <Toast>
            <ToastTitle>{message}</ToastTitle>
          </Toast>,
          { intent: 'info' },
        );
      },
    }),
    [dispatchToast],
  );
}
