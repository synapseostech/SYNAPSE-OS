import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Calendar,
  Clock,
  User,
  Phone,
  ShieldCheck,
  Video,
  ChevronRight,
} from 'lucide-react';
import { SynapseLogo } from '../../components/ui/SynapseLogo';

export default function BookingPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    email: '',
    notes: ''
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // CSPRNG id (CodeQL js/insecure-randomness #17); legacy demo, not deployed.
    const appointmentId = crypto.randomUUID();
    navigate(`/tele/booked/${appointmentId}`);
  };

  return (
    <div className="min-h-screen bg-ink text-text-1">
      <header className="h-16 border-b border-edge flex items-center justify-between px-6 sticky top-0 z-50 bg-ink/80 backdrop-blur-md">
        <Link to="/tele" className="flex items-center gap-2 text-text-3 hover:text-text-1 transition-colors group">
          <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
          <span className="text-[10px] font-black uppercase tracking-widest">Back to Triage</span>
        </Link>
        <SynapseLogo />
        <div className="w-4 h-4" />
      </header>

      <main className="max-w-3xl mx-auto p-6 md:p-12 space-y-12">
        <div className="space-y-4">
          <h2 className="heading-2">Finalize your <span className="text-gold">consultation.</span></h2>
          <p className="text-text-3 font-medium">Please confirm your details and appointment slot below.</p>
        </div>

        <div className="grid md:grid-cols-2 gap-8">
          {/* Appointment Summary */}
          <div className="space-y-6">
            <h3 className="label-sm">Appointment Summary</h3>
            <div className="card p-6 space-y-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-gold/10 border border-gold/20 flex items-center justify-center">
                  <User className="w-6 h-6 text-gold" />
                </div>
                <div>
                  <p className="text-sm font-bold text-text-1">Dr. Sarah Okello</p>
                  <p className="label-xs">General Medicine</p>
                </div>
              </div>

              <div className="space-y-4 pt-4 border-t border-edge">
                <div className="flex items-center gap-3 text-xs font-bold text-text-2">
                  <Calendar className="w-4 h-4 text-gold" />
                  Monday, 28 April 2026
                </div>
                <div className="flex items-center gap-3 text-xs font-bold text-text-2">
                  <Clock className="w-4 h-4 text-gold" />
                  10:30 AM (20 mins)
                </div>
                <div className="flex items-center gap-3 text-xs font-bold text-text-2">
                  <Video className="w-4 h-4 text-gold" />
                  Video Consultation (LiveKit)
                </div>
              </div>

              <div className="pt-4 border-t border-edge flex items-center justify-between">
                <div className="label-xs">Consultation Fee</div>
                <div className="text-lg font-black text-gold">UGX 30,000</div>
              </div>

              <div className="p-3 bg-surface-2 rounded-xl border border-edge flex items-center gap-3">
                <ShieldCheck className="w-4 h-4 text-emerald" />
                <span className="label-xs">Insurance: Not applied (pay cash)</span>
              </div>
            </div>
          </div>

          {/* Details Form */}
          <div className="space-y-6">
            <h3 className="label-sm">Your Details</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <label className="label-xs ml-1">Full Name</label>
                <input
                  required
                  className="input"
                  placeholder="Enter your full name"
                  value={formData.name}
                  onChange={e => setFormData({...formData, name: e.target.value})}
                />
              </div>
              <div className="space-y-2">
                <label className="label-xs ml-1">Phone Number (Required for SMS)</label>
                <div className="relative">
                  <Phone className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-text-3" />
                  <input
                    required
                    className="input pl-12"
                    placeholder="+256…"
                    type="tel"
                    value={formData.phone}
                    onChange={e => setFormData({...formData, phone: e.target.value})}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="label-xs ml-1">Email (Optional — for calendar invite)</label>
                <input
                  className="input"
                  placeholder="name@example.com"
                  type="email"
                  value={formData.email}
                  onChange={e => setFormData({...formData, email: e.target.value})}
                />
              </div>
              <div className="space-y-2">
                <label className="label-xs ml-1">Notes for the Doctor (Optional)</label>
                <textarea
                  className="input min-h-[100px] py-4"
                  placeholder="Describe any specifics about your symptoms…"
                  value={formData.notes}
                  onChange={e => setFormData({...formData, notes: e.target.value})}
                />
              </div>

              <button type="submit" className="btn-primary w-full py-5 text-sm group">
                Confirm Booking <ChevronRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform inline" />
              </button>

              <p className="text-[9px] text-text-3 font-bold text-center uppercase tracking-widest pt-4">
                By booking, you agree to our{' '}
                <Link to="/terms" className="text-gold hover:underline">Terms of Service</Link>
                {' '}and{' '}
                <Link to="/privacy" className="text-gold hover:underline">Privacy Policy</Link>.
              </p>
            </form>
          </div>
        </div>
      </main>

      <footer className="py-20 border-t border-edge px-6">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <SynapseLogo />
          <p className="label-xs">© 2026 Synapse Ecosystem</p>
        </div>
      </footer>
    </div>
  );
}
