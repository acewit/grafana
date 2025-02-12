import React, { PureComponent } from 'react';
import { css, cx } from 'emotion';
import { last } from 'lodash';

import { Themeable, withTheme, GrafanaTheme, selectThemeVariant, getLogRowStyles } from '@grafana/ui';
import { LogsModel, LogRowModel, TimeZone } from '@grafana/data';

import ElapsedTime from './ElapsedTime';

const getStyles = (theme: GrafanaTheme) => ({
  logsRowsLive: css`
    label: logs-rows-live;
    font-family: ${theme.typography.fontFamily.monospace};
    font-size: ${theme.typography.size.sm};
    display: flex;
    flex-flow: column nowrap;
    height: 65vh;
    overflow-y: auto;
    :first-child {
      margin-top: auto !important;
    }
  `,
  logsRowFresh: css`
    label: logs-row-fresh;
    color: ${theme.colors.text};
    background-color: ${selectThemeVariant(
      { light: theme.background.logsFresh, dark: theme.background.logsFresh },
      theme.type
    )};
    animation: fade 1s ease-out 1s 1 normal forwards;
    @keyframes fade {
      from {
        background-color: ${selectThemeVariant(
          { light: theme.background.logsFresh, dark: theme.background.logsFresh },
          theme.type
        )};
      }
      to {
        background-color: transparent;
      }
    }
  `,
  logsRowOld: css`
    label: logs-row-old;
  `,
  logsRowsIndicator: css`
    font-size: ${theme.typography.size.md};
    padding-top: ${theme.spacing.sm};
    display: flex;
    align-items: center;
  `,
  button: css`
    margin-right: ${theme.spacing.sm};
  `,
});

export interface Props extends Themeable {
  logsResult?: LogsModel;
  timeZone: TimeZone;
  stopLive: () => void;
  onPause: () => void;
  onResume: () => void;
  isPaused: boolean;
}

interface State {
  logsResultToRender?: LogsModel;
  lastTimestamp: number;
}

class LiveLogs extends PureComponent<Props, State> {
  private liveEndDiv: HTMLDivElement = null;
  private scrollContainerRef = React.createRef<HTMLDivElement>();
  private lastScrollPos: number | null = null;

  constructor(props: Props) {
    super(props);
    this.state = {
      logsResultToRender: props.logsResult,
      lastTimestamp: 0,
    };
  }

  componentDidUpdate(prevProps: Props) {
    if (!prevProps.isPaused && this.props.isPaused) {
      // So we paused the view and we changed the content size, but we want to keep the relative offset from the bottom.
      if (this.lastScrollPos) {
        // There is last scroll pos from when user scrolled up a bit so go to that position.
        const { clientHeight, scrollHeight } = this.scrollContainerRef.current;
        const scrollTop = scrollHeight - (this.lastScrollPos + clientHeight);
        this.scrollContainerRef.current.scrollTo(0, scrollTop);
        this.lastScrollPos = null;
      } else {
        // We do not have any position to jump to su the assumption is user just clicked pause. We can just scroll
        // to the bottom.
        if (this.liveEndDiv) {
          this.liveEndDiv.scrollIntoView(false);
        }
      }
    }
  }

  static getDerivedStateFromProps(nextProps: Props, state: State) {
    if (!nextProps.isPaused) {
      return {
        // We update what we show only if not paused. We keep any background subscriptions running and keep updating
        // our state, but we do not show the updates, this allows us start again showing correct result after resuming
        // without creating a gap in the log results.
        logsResultToRender: nextProps.logsResult,
        lastTimestamp:
          state.logsResultToRender && last(state.logsResultToRender.rows)
            ? last(state.logsResultToRender.rows).timeEpochMs
            : 0,
      };
    } else {
      return null;
    }
  }

  /**
   * Handle pausing when user scrolls up so that we stop resetting his position to the bottom when new row arrives.
   * We do not need to throttle it here much, adding new rows should be throttled/buffered itself in the query epics
   * and after you pause we remove the handler and add it after you manually resume, so this should not be fired often.
   */
  onScroll = (event: React.SyntheticEvent) => {
    const { isPaused, onPause } = this.props;
    const { scrollTop, clientHeight, scrollHeight } = event.currentTarget;
    const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
    if (distanceFromBottom >= 5 && !isPaused) {
      onPause();
      this.lastScrollPos = distanceFromBottom;
    }
  };

  rowsToRender = () => {
    const { isPaused } = this.props;
    let rowsToRender: LogRowModel[] = this.state.logsResultToRender ? this.state.logsResultToRender.rows : [];
    if (!isPaused) {
      // A perf optimisation here. Show just 100 rows when streaming and full length when the streaming is paused.
      rowsToRender = rowsToRender.slice(-100);
    }
    return rowsToRender;
  };

  /**
   * Check if row is fresh so we can apply special styling. This is bit naive and does not take into account rows
   * which arrive out of order. Because loki datasource sends full data instead of deltas we need to compare the
   * data and this is easier than doing some intersection of some uuid of each row (which we do not have now anyway)
   */
  isFresh = (row: LogRowModel): boolean => {
    return row.timeEpochMs > this.state.lastTimestamp;
  };

  render() {
    const { theme, timeZone, onPause, onResume, isPaused } = this.props;
    const styles = getStyles(theme);
    const showUtc = timeZone === 'utc';
    const { logsRow, logsRowLocalTime, logsRowMessage } = getLogRowStyles(theme);

    return (
      <>
        <div
          onScroll={isPaused ? undefined : this.onScroll}
          className={cx(['logs-rows', styles.logsRowsLive])}
          ref={this.scrollContainerRef}
        >
          {this.rowsToRender().map((row: LogRowModel, index) => {
            return (
              <div
                className={cx(logsRow, this.isFresh(row) ? styles.logsRowFresh : styles.logsRowOld)}
                key={`${row.timeEpochMs}-${index}`}
              >
                {showUtc && (
                  <div className={cx([logsRowLocalTime])} title={`Local: ${row.timeLocal} (${row.timeFromNow})`}>
                    {row.timeUtc}
                  </div>
                )}
                {!showUtc && (
                  <div className={cx([logsRowLocalTime])} title={`${row.timeUtc} (${row.timeFromNow})`}>
                    {row.timeLocal}
                  </div>
                )}
                <div className={cx([logsRowMessage])}>{row.entry}</div>
              </div>
            );
          })}
          <div
            ref={element => {
              this.liveEndDiv = element;
              // This is triggered on every update so on every new row. It keeps the view scrolled at the bottom by
              // default.
              if (this.liveEndDiv && !isPaused) {
                this.liveEndDiv.scrollIntoView(false);
              }
            }}
          />
        </div>
        <div className={cx([styles.logsRowsIndicator])}>
          <button onClick={isPaused ? onResume : onPause} className={cx('btn btn-secondary', styles.button)}>
            <i className={cx('fa', isPaused ? 'fa-play' : 'fa-pause')} />
            &nbsp;
            {isPaused ? 'Resume' : 'Pause'}
          </button>
          <button onClick={this.props.stopLive} className={cx('btn btn-inverse', styles.button)}>
            <i className={'fa fa-times'} />
            &nbsp; Exit live mode
          </button>
          {isPaused || (
            <span>
              Last line received: <ElapsedTime resetKey={this.props.logsResult} humanize={true} /> ago
            </span>
          )}
        </div>
      </>
    );
  }
}

export const LiveLogsWithTheme = withTheme(LiveLogs);
