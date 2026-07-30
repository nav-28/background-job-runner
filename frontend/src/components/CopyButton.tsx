'use client';

import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import { useEffect, useRef, useState } from 'react';
import { enqueueSnackbar } from '@/components/GlobalSnackbar/store';
import { copyToClipboard } from '@/lib/utils/clipboard';

const COPIED_RESET_MS = 1500;

interface CopyButtonProps {
  value: string;
  label?: string;
  title?: string;
}

export default function CopyButton({ value, label, title = 'Copy' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const handleClick = async () => {
    if (!(await copyToClipboard(value))) {
      enqueueSnackbar('Could not reach the clipboard. Select the text and copy it manually.', {
        variant: 'error',
      });
      return;
    }

    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  const icon = copied ? <CheckIcon fontSize="small" /> : <ContentCopyIcon fontSize="small" />;

  if (label) {
    return (
      <Button size="small" variant="outlined" startIcon={icon} onClick={() => void handleClick()}>
        {copied ? 'Copied' : label}
      </Button>
    );
  }

  return (
    <Tooltip title={copied ? 'Copied' : title}>
      <IconButton size="small" aria-label={title} onClick={() => void handleClick()}>
        {icon}
      </IconButton>
    </Tooltip>
  );
}
