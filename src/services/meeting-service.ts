import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";

export class MeetingService {
  async getEligibility(memberId: string) {
    const { data, error } = await supabaseAdmin.from('track_meetings').select('*').eq('member_id', memberId).order('meeting_start', { ascending: false });
    if (error) throw new HttpError(500, 'Failed to fetch meetings', error);
    return {
      performance: { eligible: true, nextEligibleDate: null },
      pace: { eligible: true, nextEligibleDate: null },
      structure: { eligible: true, nextEligibleDate: null },
      history: data ?? [],
    };
  }

  async createMeeting(input: { memberId: string; tier: 'performance'|'pace'|'structure'; meetingStart: string; meetingEnd: string; }) {
    const { data, error } = await supabaseAdmin.from('track_meetings').insert({ member_id: input.memberId, tier: input.tier, meeting_start: input.meetingStart, meeting_end: input.meetingEnd }).select().single();
    if (error) throw new HttpError(500, 'Failed to create meeting', error);
    return data;
  }
}
