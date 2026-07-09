import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SetupScreen, type SetupPayload } from './SetupScreen';

function cvFile() {
  return new File(['# CV'], 'me.md', { type: 'text/markdown' });
}

describe('SetupScreen', () => {
  it('blocks submission and flags the CV when none is chosen', async () => {
    const onBegin = vi.fn();
    render(<SetupScreen onBegin={onBegin} />);

    await userEvent.click(screen.getByRole('button', { name: /raise the curtain/i }));

    expect(onBegin).not.toHaveBeenCalled();
    expect(screen.getByText(/bring your cv/i)).toBeInTheDocument();
  });

  it('flags a missing posting even when the CV is present', async () => {
    const onBegin = vi.fn();
    render(<SetupScreen onBegin={onBegin} />);

    await userEvent.upload(screen.getByLabelText(/cv file/i), cvFile());
    await userEvent.click(screen.getByRole('button', { name: /raise the curtain/i }));

    expect(onBegin).not.toHaveBeenCalled();
    expect(screen.getByText(/add the posting/i)).toBeInTheDocument();
  });

  it('submits the CV and pasted posting text', async () => {
    const onBegin = vi.fn();
    render(<SetupScreen onBegin={onBegin} />);

    await userEvent.upload(screen.getByLabelText(/cv file/i), cvFile());
    await userEvent.click(screen.getByRole('button', { name: /paste/i }));
    await userEvent.type(screen.getByPlaceholderText(/paste the posting/i), 'Senior Backend Engineer.');
    await userEvent.click(screen.getByRole('button', { name: /raise the curtain/i }));

    expect(onBegin).toHaveBeenCalledTimes(1);
    const payload = onBegin.mock.calls[0]?.[0] as SetupPayload;
    expect(payload.postingKind).toBe('paste');
    expect(payload.job).toBe('Senior Backend Engineer.');
    expect(payload.cv.name).toBe('me.md');
  });

  it('submits a posting link from the link field', async () => {
    const onBegin = vi.fn();
    render(<SetupScreen onBegin={onBegin} />);

    await userEvent.upload(screen.getByLabelText(/cv file/i), cvFile());
    await userEvent.type(
      screen.getByPlaceholderText(/jobs\.example\.com|https/i),
      'https://jobs.example.com/staff',
    );
    await userEvent.click(screen.getByRole('button', { name: /raise the curtain/i }));

    const payload = onBegin.mock.calls[0]?.[0] as SetupPayload;
    expect(payload.postingKind).toBe('link');
    expect(payload.job).toBe('https://jobs.example.com/staff');
  });

  it('shows a preparation error when one is passed', () => {
    render(<SetupScreen onBegin={vi.fn()} error="Upload failed." />);
    expect(screen.getByText('Upload failed.')).toBeInTheDocument();
  });
});
