'use client';

import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormHelperText from '@mui/material/FormHelperText';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { useCreateTask } from '@/lib/api/endpoints/tasks/tasks';
import type { LaneParam, LaneResponse } from '@/lib/api/model';

interface SubmitTaskDialogProps {
  open: boolean;
  onClose: () => void;
  lanes: LaneResponse[];
  onSubmitted: () => void;
}

/** `undefined` means "the user has not supplied this", which is not the same as `false` or `''`. */
type FieldValue = string | boolean | undefined;

function descriptorValue(param: LaneParam): FieldValue {
  // A descriptor with no `default` stays empty: the server applies its own
  // behaviour when the key is absent, and guessing here would override it.
  if (param.default === undefined) return param.type === 'boolean' ? undefined : '';
  return param.type === 'boolean' ? param.default === true : String(param.default);
}

function fieldError(param: LaneParam, value: FieldValue): string | undefined {
  const empty = value === undefined || value === '';

  if (param.required && empty) return 'Required';
  if (param.type !== 'number' || empty) return undefined;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 'Must be a number';
  if (param.min !== undefined && parsed < param.min) return `Must be at least ${param.min}`;
  if (param.max !== undefined && parsed > param.max) return `Must be at most ${param.max}`;
  return undefined;
}

export default function SubmitTaskDialog({
  open,
  onClose,
  lanes,
  onSubmitted,
}: SubmitTaskDialogProps) {
  const [laneName, setLaneName] = useState('');
  const [overrides, setOverrides] = useState<Record<string, FieldValue>>({});

  // Falling back to the first lane means a dialog opened before /lanes resolved
  // picks one up as soon as it arrives, without an effect to sync it.
  const lane = lanes.find((candidate) => candidate.lane === laneName) ?? lanes[0];

  const currentValue = (param: LaneParam): FieldValue =>
    overrides[param.name] ?? descriptorValue(param);

  const params = lane?.params ?? [];
  const errors = new Map(
    params.map((param) => [param.name, fieldError(param, currentValue(param))]),
  );
  const valid = lane !== undefined && [...errors.values()].every((error) => error === undefined);

  const createTask = useCreateTask({
    mutation: {
      onSuccess: () => {
        onSubmitted();
        handleClose();
      },
    },
  });

  function handleClose() {
    setOverrides({});
    onClose();
  }

  function selectLane(next: string) {
    setLaneName(next);
    setOverrides({});
  }

  function handleSubmit() {
    if (!lane || !valid) return;

    const payload: Record<string, unknown> = {};
    for (const param of params) {
      const value = currentValue(param);
      if (value === undefined || value === '') continue;
      payload[param.name] = param.type === 'number' ? Number(value) : value;
    }

    createTask.mutate({
      data:
        Object.keys(payload).length > 0
          ? { lane: lane.lane, params: payload }
          : { lane: lane.lane },
    });
  }

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
      <DialogTitle>Submit a task</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <TextField
            select
            fullWidth
            label="Lane"
            disabled={lanes.length === 0}
            value={lane?.lane ?? ''}
            onChange={(event) => selectLane(event.target.value)}
            helperText={lane?.description ?? 'Loading lanes…'}
          >
            {lanes.map((option) => (
              <MenuItem key={option.lane} value={option.lane}>
                {option.lane}
                {option.description ? ` — ${option.description}` : ''}
              </MenuItem>
            ))}
          </TextField>

          {params.length === 0 && lane ? (
            <Typography variant="body2" color="text.secondary">
              This lane takes no parameters.
            </Typography>
          ) : null}

          {params.map((param) => {
            const value = currentValue(param);
            const error = errors.get(param.name);
            const setValue = (next: FieldValue) =>
              setOverrides((current) => ({ ...current, [param.name]: next }));

            if (param.type === 'boolean') {
              return (
                <div key={param.name}>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={value === true}
                        onChange={(event) => setValue(event.target.checked)}
                      />
                    }
                    label={param.required ? `${param.name} *` : param.name}
                  />
                  {param.description || error ? (
                    <FormHelperText error={Boolean(error)}>
                      {error ?? param.description}
                    </FormHelperText>
                  ) : null}
                </div>
              );
            }

            return (
              <TextField
                key={param.name}
                fullWidth
                label={param.name}
                required={param.required}
                type={param.type === 'number' ? 'number' : 'text'}
                value={typeof value === 'string' ? value : ''}
                onChange={(event) => setValue(event.target.value)}
                error={Boolean(error)}
                helperText={error ?? param.description}
                slotProps={
                  param.type === 'number'
                    ? { htmlInput: { min: param.min, max: param.max, step: 'any' } }
                    : undefined
                }
              />
            );
          })}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={!valid}
          loading={createTask.isPending}
        >
          Submit
        </Button>
      </DialogActions>
    </Dialog>
  );
}
