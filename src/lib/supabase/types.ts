export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: '12.2.3 (519615d)';
  };
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: {
          extensions?: Json;
          operationName?: string;
          query?: string;
          variables?: Json;
        };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      basketball_player_profiles: {
        Row: {
          created_at: string | null;
          device_metrics: Json | null;
          experience_level: Database['public']['Enums']['basketball_experience_level'];
          id: string;
          metadata: Json | null;
          preferred_hand: string | null;
          preferred_jersey_number: number | null;
          primary_position: string | null;
          profile_variant_id: string;
          secondary_positions: string[] | null;
          updated_at: string | null;
        };
        Insert: {
          created_at?: string | null;
          device_metrics?: Json | null;
          experience_level: Database['public']['Enums']['basketball_experience_level'];
          id?: string;
          metadata?: Json | null;
          preferred_hand?: string | null;
          preferred_jersey_number?: number | null;
          primary_position?: string | null;
          profile_variant_id: string;
          secondary_positions?: string[] | null;
          updated_at?: string | null;
        };
        Update: {
          created_at?: string | null;
          device_metrics?: Json | null;
          experience_level?: Database['public']['Enums']['basketball_experience_level'];
          id?: string;
          metadata?: Json | null;
          preferred_hand?: string | null;
          preferred_jersey_number?: number | null;
          primary_position?: string | null;
          profile_variant_id?: string;
          secondary_positions?: string[] | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'basketball_player_profiles_profile_variant_id_fkey';
            columns: ['profile_variant_id'];
            isOneToOne: true;
            referencedRelation: 'profile_variants';
            referencedColumns: ['id'];
          },
        ];
      };
      career_history: {
        Row: {
          achievements: string[] | null;
          created_at: string | null;
          description: string | null;
          display_order: number | null;
          end_date: string | null;
          id: string;
          is_current: boolean | null;
          organization_id: string | null;
          organization_name: string | null;
          profile_variant_id: string;
          role: string | null;
          start_date: string | null;
          updated_at: string | null;
          verified: boolean | null;
        };
        Insert: {
          achievements?: string[] | null;
          created_at?: string | null;
          description?: string | null;
          display_order?: number | null;
          end_date?: string | null;
          id?: string;
          is_current?: boolean | null;
          organization_id?: string | null;
          organization_name?: string | null;
          profile_variant_id: string;
          role?: string | null;
          start_date?: string | null;
          updated_at?: string | null;
          verified?: boolean | null;
        };
        Update: {
          achievements?: string[] | null;
          created_at?: string | null;
          description?: string | null;
          display_order?: number | null;
          end_date?: string | null;
          id?: string;
          is_current?: boolean | null;
          organization_id?: string | null;
          organization_name?: string | null;
          profile_variant_id?: string;
          role?: string | null;
          start_date?: string | null;
          updated_at?: string | null;
          verified?: boolean | null;
        };
        Relationships: [
          {
            foreignKeyName: 'career_history_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'career_history_profile_variant_id_fkey';
            columns: ['profile_variant_id'];
            isOneToOne: false;
            referencedRelation: 'profile_variants';
            referencedColumns: ['id'];
          },
        ];
      };
      connections: {
        Row: {
          created_at: string | null;
          id: string;
          message: string | null;
          recipient_id: string | null;
          requester_id: string | null;
          status: string | null;
          updated_at: string | null;
        };
        Insert: {
          created_at?: string | null;
          id?: string;
          message?: string | null;
          recipient_id?: string | null;
          requester_id?: string | null;
          status?: string | null;
          updated_at?: string | null;
        };
        Update: {
          created_at?: string | null;
          id?: string;
          message?: string | null;
          recipient_id?: string | null;
          requester_id?: string | null;
          status?: string | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'connections_recipient_id_fkey';
            columns: ['recipient_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'connections_requester_id_fkey';
            columns: ['requester_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      education: {
        Row: {
          achievements: string[] | null;
          created_at: string | null;
          degree_or_program: string | null;
          description: string | null;
          display_order: number | null;
          end_date: string | null;
          field_of_study: string | null;
          id: string;
          institution_name: string;
          institution_type: string | null;
          is_current: boolean | null;
          profile_id: string;
          start_date: string | null;
          updated_at: string | null;
          verified: boolean | null;
        };
        Insert: {
          achievements?: string[] | null;
          created_at?: string | null;
          degree_or_program?: string | null;
          description?: string | null;
          display_order?: number | null;
          end_date?: string | null;
          field_of_study?: string | null;
          id?: string;
          institution_name: string;
          institution_type?: string | null;
          is_current?: boolean | null;
          profile_id: string;
          start_date?: string | null;
          updated_at?: string | null;
          verified?: boolean | null;
        };
        Update: {
          achievements?: string[] | null;
          created_at?: string | null;
          degree_or_program?: string | null;
          description?: string | null;
          display_order?: number | null;
          end_date?: string | null;
          field_of_study?: string | null;
          id?: string;
          institution_name?: string;
          institution_type?: string | null;
          is_current?: boolean | null;
          profile_id?: string;
          start_date?: string | null;
          updated_at?: string | null;
          verified?: boolean | null;
        };
        Relationships: [
          {
            foreignKeyName: 'education_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      football_player_profiles: {
        Row: {
          created_at: string | null;
          experience_level: Database['public']['Enums']['football_experience_level'];
          id: string;
          metadata: Json | null;
          player_data_metrics: Json | null;
          preferred_foot: string | null;
          preferred_jersey_number: number | null;
          primary_position: string | null;
          profile_variant_id: string;
          secondary_positions: string[] | null;
          updated_at: string | null;
        };
        Insert: {
          created_at?: string | null;
          experience_level: Database['public']['Enums']['football_experience_level'];
          id?: string;
          metadata?: Json | null;
          player_data_metrics?: Json | null;
          preferred_foot?: string | null;
          preferred_jersey_number?: number | null;
          primary_position?: string | null;
          profile_variant_id: string;
          secondary_positions?: string[] | null;
          updated_at?: string | null;
        };
        Update: {
          created_at?: string | null;
          experience_level?: Database['public']['Enums']['football_experience_level'];
          id?: string;
          metadata?: Json | null;
          player_data_metrics?: Json | null;
          preferred_foot?: string | null;
          preferred_jersey_number?: number | null;
          primary_position?: string | null;
          profile_variant_id?: string;
          secondary_positions?: string[] | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'football_player_profiles_profile_variant_id_fkey';
            columns: ['profile_variant_id'];
            isOneToOne: true;
            referencedRelation: 'profile_variants';
            referencedColumns: ['id'];
          },
        ];
      };
      highlights: {
        Row: {
          created_at: string | null;
          description: string | null;
          duration: number | null;
          id: string;
          is_public: boolean | null;
          like_count: number | null;
          metadata: Json | null;
          profile_id: string | null;
          profile_variant_id: string | null;
          sport_id: string | null;
          tags: string[] | null;
          thumbnail_url: string | null;
          title: string;
          updated_at: string | null;
          video_url: string;
          view_count: number | null;
        };
        Insert: {
          created_at?: string | null;
          description?: string | null;
          duration?: number | null;
          id?: string;
          is_public?: boolean | null;
          like_count?: number | null;
          metadata?: Json | null;
          profile_id?: string | null;
          profile_variant_id?: string | null;
          sport_id?: string | null;
          tags?: string[] | null;
          thumbnail_url?: string | null;
          title: string;
          updated_at?: string | null;
          video_url: string;
          view_count?: number | null;
        };
        Update: {
          created_at?: string | null;
          description?: string | null;
          duration?: number | null;
          id?: string;
          is_public?: boolean | null;
          like_count?: number | null;
          metadata?: Json | null;
          profile_id?: string | null;
          profile_variant_id?: string | null;
          sport_id?: string | null;
          tags?: string[] | null;
          thumbnail_url?: string | null;
          title?: string;
          updated_at?: string | null;
          video_url?: string;
          view_count?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'highlights_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'highlights_profile_variant_id_fkey';
            columns: ['profile_variant_id'];
            isOneToOne: false;
            referencedRelation: 'profile_variants';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'highlights_sport_id_fkey';
            columns: ['sport_id'];
            isOneToOne: false;
            referencedRelation: 'sports';
            referencedColumns: ['id'];
          },
        ];
      };
      organization_members: {
        Row: {
          contract_end: string | null;
          contract_start: string | null;
          created_at: string | null;
          id: string;
          is_active: boolean | null;
          jersey_number: number | null;
          metadata: Json | null;
          organization_id: string | null;
          permissions: Json | null;
          profile_id: string | null;
          profile_variant_id: string | null;
          role: Database['public']['Enums']['profile_variant_type'];
          updated_at: string | null;
        };
        Insert: {
          contract_end?: string | null;
          contract_start?: string | null;
          created_at?: string | null;
          id?: string;
          is_active?: boolean | null;
          jersey_number?: number | null;
          metadata?: Json | null;
          organization_id?: string | null;
          permissions?: Json | null;
          profile_id?: string | null;
          profile_variant_id?: string | null;
          role: Database['public']['Enums']['profile_variant_type'];
          updated_at?: string | null;
        };
        Update: {
          contract_end?: string | null;
          contract_start?: string | null;
          created_at?: string | null;
          id?: string;
          is_active?: boolean | null;
          jersey_number?: number | null;
          metadata?: Json | null;
          organization_id?: string | null;
          permissions?: Json | null;
          profile_id?: string | null;
          profile_variant_id?: string | null;
          role?: Database['public']['Enums']['profile_variant_type'];
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'organization_members_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'organization_members_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'organization_members_profile_variant_id_fkey';
            columns: ['profile_variant_id'];
            isOneToOne: false;
            referencedRelation: 'profile_variants';
            referencedColumns: ['id'];
          },
        ];
      };
      organizations: {
        Row: {
          contact_info: Json | null;
          country_code: string | null;
          cover_image_url: string | null;
          created_at: string | null;
          created_by: string | null;
          description: string | null;
          founded_year: number | null;
          id: string;
          is_active: boolean | null;
          is_verified: boolean | null;
          level: string | null;
          location: string | null;
          logo_url: string | null;
          member_count: number | null;
          name: string;
          parent_organization_id: string | null;
          settings: Json | null;
          slug: string;
          social_links: Json | null;
          sport_ids: string[] | null;
          type: string;
          updated_at: string | null;
          website: string | null;
        };
        Insert: {
          contact_info?: Json | null;
          country_code?: string | null;
          cover_image_url?: string | null;
          created_at?: string | null;
          created_by?: string | null;
          description?: string | null;
          founded_year?: number | null;
          id?: string;
          is_active?: boolean | null;
          is_verified?: boolean | null;
          level?: string | null;
          location?: string | null;
          logo_url?: string | null;
          member_count?: number | null;
          name: string;
          parent_organization_id?: string | null;
          settings?: Json | null;
          slug: string;
          social_links?: Json | null;
          sport_ids?: string[] | null;
          type: string;
          updated_at?: string | null;
          website?: string | null;
        };
        Update: {
          contact_info?: Json | null;
          country_code?: string | null;
          cover_image_url?: string | null;
          created_at?: string | null;
          created_by?: string | null;
          description?: string | null;
          founded_year?: number | null;
          id?: string;
          is_active?: boolean | null;
          is_verified?: boolean | null;
          level?: string | null;
          location?: string | null;
          logo_url?: string | null;
          member_count?: number | null;
          name?: string;
          parent_organization_id?: string | null;
          settings?: Json | null;
          slug?: string;
          social_links?: Json | null;
          sport_ids?: string[] | null;
          type?: string;
          updated_at?: string | null;
          website?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'organizations_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'organizations_parent_organization_id_fkey';
            columns: ['parent_organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
        ];
      };
      playscanner_cache: {
        Row: {
          cache_key: string;
          city: string;
          created_at: string | null;
          date: string;
          expires_at: string;
          id: string;
          metadata: Json | null;
          slots: Json;
        };
        Insert: {
          cache_key: string;
          city: string;
          created_at?: string | null;
          date: string;
          expires_at: string;
          id?: string;
          metadata?: Json | null;
          slots: Json;
        };
        Update: {
          cache_key?: string;
          city?: string;
          created_at?: string | null;
          date?: string;
          expires_at?: string;
          id?: string;
          metadata?: Json | null;
          slots?: Json;
        };
        Relationships: [];
      };
      playscanner_collection_log: {
        Row: {
          city: string;
          collection_id: string;
          created_at: string | null;
          date: string;
          error_message: string | null;
          execution_time_ms: number | null;
          id: string;
          provider: string | null;
          slots_collected: number | null;
          status: string;
          venues_processed: number | null;
        };
        Insert: {
          city: string;
          collection_id: string;
          created_at?: string | null;
          date: string;
          error_message?: string | null;
          execution_time_ms?: number | null;
          id?: string;
          provider?: string | null;
          slots_collected?: number | null;
          status: string;
          venues_processed?: number | null;
        };
        Update: {
          city?: string;
          collection_id?: string;
          created_at?: string | null;
          date?: string;
          error_message?: string | null;
          execution_time_ms?: number | null;
          id?: string;
          provider?: string | null;
          slots_collected?: number | null;
          status?: string;
          venues_processed?: number | null;
        };
        Relationships: [];
      };
      playscanner_conversions: {
        Row: {
          booking_url: string | null;
          clicked_at: string | null;
          commission_rate: number | null;
          estimated_commission: number | null;
          estimated_price: number | null;
          id: string;
          provider_name: string;
          search_id: string | null;
          session_id: string | null;
          sport: string | null;
          venue_location: string | null;
          venue_name: string | null;
        };
        Insert: {
          booking_url?: string | null;
          clicked_at?: string | null;
          commission_rate?: number | null;
          estimated_commission?: number | null;
          estimated_price?: number | null;
          id?: string;
          provider_name: string;
          search_id?: string | null;
          session_id?: string | null;
          sport?: string | null;
          venue_location?: string | null;
          venue_name?: string | null;
        };
        Update: {
          booking_url?: string | null;
          clicked_at?: string | null;
          commission_rate?: number | null;
          estimated_commission?: number | null;
          estimated_price?: number | null;
          id?: string;
          provider_name?: string;
          search_id?: string | null;
          session_id?: string | null;
          sport?: string | null;
          venue_location?: string | null;
          venue_name?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'playscanner_conversions_search_id_fkey';
            columns: ['search_id'];
            isOneToOne: false;
            referencedRelation: 'playscanner_searches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'playscanner_conversions_session_id_fkey';
            columns: ['session_id'];
            isOneToOne: false;
            referencedRelation: 'playscanner_sessions';
            referencedColumns: ['session_id'];
          },
        ];
      };
      playscanner_page_views: {
        Row: {
          id: string;
          page_type: string;
          page_url: string | null;
          referrer: string | null;
          session_id: string | null;
          time_on_page: number | null;
          viewed_at: string | null;
        };
        Insert: {
          id?: string;
          page_type: string;
          page_url?: string | null;
          referrer?: string | null;
          session_id?: string | null;
          time_on_page?: number | null;
          viewed_at?: string | null;
        };
        Update: {
          id?: string;
          page_type?: string;
          page_url?: string | null;
          referrer?: string | null;
          session_id?: string | null;
          time_on_page?: number | null;
          viewed_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'playscanner_page_views_session_id_fkey';
            columns: ['session_id'];
            isOneToOne: false;
            referencedRelation: 'playscanner_sessions';
            referencedColumns: ['session_id'];
          },
        ];
      };
      playscanner_searches: {
        Row: {
          id: string;
          results_count: number | null;
          search_duration_ms: number | null;
          search_params: Json | null;
          searched_at: string | null;
          session_id: string | null;
          viewed_providers: string[] | null;
        };
        Insert: {
          id?: string;
          results_count?: number | null;
          search_duration_ms?: number | null;
          search_params?: Json | null;
          searched_at?: string | null;
          session_id?: string | null;
          viewed_providers?: string[] | null;
        };
        Update: {
          id?: string;
          results_count?: number | null;
          search_duration_ms?: number | null;
          search_params?: Json | null;
          searched_at?: string | null;
          session_id?: string | null;
          viewed_providers?: string[] | null;
        };
        Relationships: [
          {
            foreignKeyName: 'playscanner_searches_session_id_fkey';
            columns: ['session_id'];
            isOneToOne: false;
            referencedRelation: 'playscanner_sessions';
            referencedColumns: ['session_id'];
          },
        ];
      };
      playscanner_sessions: {
        Row: {
          booking_clicks: number | null;
          city: string | null;
          country_code: string | null;
          created_at: string | null;
          id: string;
          ip_address: unknown | null;
          last_activity: string | null;
          page_views: number | null;
          search_queries: number | null;
          session_duration: number | null;
          session_id: string;
          started_at: string | null;
          user_agent: string | null;
          user_id: string | null;
        };
        Insert: {
          booking_clicks?: number | null;
          city?: string | null;
          country_code?: string | null;
          created_at?: string | null;
          id?: string;
          ip_address?: unknown | null;
          last_activity?: string | null;
          page_views?: number | null;
          search_queries?: number | null;
          session_duration?: number | null;
          session_id: string;
          started_at?: string | null;
          user_agent?: string | null;
          user_id?: string | null;
        };
        Update: {
          booking_clicks?: number | null;
          city?: string | null;
          country_code?: string | null;
          created_at?: string | null;
          id?: string;
          ip_address?: unknown | null;
          last_activity?: string | null;
          page_views?: number | null;
          search_queries?: number | null;
          session_duration?: number | null;
          session_id?: string;
          started_at?: string | null;
          user_agent?: string | null;
          user_id?: string | null;
        };
        Relationships: [];
      };
      profile_variant_sports: {
        Row: {
          achievements: Json | null;
          created_at: string | null;
          id: string;
          is_primary: boolean | null;
          profile_variant_id: string | null;
          sport_id: string | null;
          started_date: string | null;
          statistics: Json | null;
          updated_at: string | null;
        };
        Insert: {
          achievements?: Json | null;
          created_at?: string | null;
          id?: string;
          is_primary?: boolean | null;
          profile_variant_id?: string | null;
          sport_id?: string | null;
          started_date?: string | null;
          statistics?: Json | null;
          updated_at?: string | null;
        };
        Update: {
          achievements?: Json | null;
          created_at?: string | null;
          id?: string;
          is_primary?: boolean | null;
          profile_variant_id?: string | null;
          sport_id?: string | null;
          started_date?: string | null;
          statistics?: Json | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'profile_variant_sports_profile_variant_id_fkey';
            columns: ['profile_variant_id'];
            isOneToOne: false;
            referencedRelation: 'profile_variants';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'profile_variant_sports_sport_id_fkey';
            columns: ['sport_id'];
            isOneToOne: false;
            referencedRelation: 'sports';
            referencedColumns: ['id'];
          },
        ];
      };
      profile_variants: {
        Row: {
          created_at: string | null;
          display_name: string | null;
          id: string;
          is_active: boolean | null;
          is_primary: boolean | null;
          is_searchable: boolean | null;
          is_verified: boolean | null;
          profile_id: string;
          sport_id: string | null;
          tags: string[] | null;
          updated_at: string | null;
          variant_bio: string | null;
          variant_type: Database['public']['Enums']['profile_variant_type'];
          verification_date: string | null;
        };
        Insert: {
          created_at?: string | null;
          display_name?: string | null;
          id?: string;
          is_active?: boolean | null;
          is_primary?: boolean | null;
          is_searchable?: boolean | null;
          is_verified?: boolean | null;
          profile_id: string;
          sport_id?: string | null;
          tags?: string[] | null;
          updated_at?: string | null;
          variant_bio?: string | null;
          variant_type: Database['public']['Enums']['profile_variant_type'];
          verification_date?: string | null;
        };
        Update: {
          created_at?: string | null;
          display_name?: string | null;
          id?: string;
          is_active?: boolean | null;
          is_primary?: boolean | null;
          is_searchable?: boolean | null;
          is_verified?: boolean | null;
          profile_id?: string;
          sport_id?: string | null;
          tags?: string[] | null;
          updated_at?: string | null;
          variant_bio?: string | null;
          variant_type?: Database['public']['Enums']['profile_variant_type'];
          verification_date?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'profile_variants_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'profile_variants_sport_id_fkey';
            columns: ['sport_id'];
            isOneToOne: false;
            referencedRelation: 'sports';
            referencedColumns: ['id'];
          },
        ];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          bio: string | null;
          cover_image_url: string | null;
          created_at: string | null;
          date_of_birth: string | null;
          email: string | null;
          full_name: string | null;
          height_cm: number | null;
          id: string;
          is_public: boolean | null;
          location: string | null;
          nationality: string | null;
          phone: string | null;
          social_links: Json | null;
          updated_at: string | null;
          user_id: string;
          username: string;
          website: string | null;
          weight_kg: number | null;
        };
        Insert: {
          avatar_url?: string | null;
          bio?: string | null;
          cover_image_url?: string | null;
          created_at?: string | null;
          date_of_birth?: string | null;
          email?: string | null;
          full_name?: string | null;
          height_cm?: number | null;
          id?: string;
          is_public?: boolean | null;
          location?: string | null;
          nationality?: string | null;
          phone?: string | null;
          social_links?: Json | null;
          updated_at?: string | null;
          user_id: string;
          username: string;
          website?: string | null;
          weight_kg?: number | null;
        };
        Update: {
          avatar_url?: string | null;
          bio?: string | null;
          cover_image_url?: string | null;
          created_at?: string | null;
          date_of_birth?: string | null;
          email?: string | null;
          full_name?: string | null;
          height_cm?: number | null;
          id?: string;
          is_public?: boolean | null;
          location?: string | null;
          nationality?: string | null;
          phone?: string | null;
          social_links?: Json | null;
          updated_at?: string | null;
          user_id?: string;
          username?: string;
          website?: string | null;
          weight_kg?: number | null;
        };
        Relationships: [];
      };
      provider_analytics: {
        Row: {
          avg_booking_value: number | null;
          conversion_rate: number | null;
          date: string;
          estimated_revenue: number | null;
          id: string;
          provider_name: string;
          total_clicks: number | null;
          total_impressions: number | null;
          updated_at: string | null;
        };
        Insert: {
          avg_booking_value?: number | null;
          conversion_rate?: number | null;
          date: string;
          estimated_revenue?: number | null;
          id?: string;
          provider_name: string;
          total_clicks?: number | null;
          total_impressions?: number | null;
          updated_at?: string | null;
        };
        Update: {
          avg_booking_value?: number | null;
          conversion_rate?: number | null;
          date?: string;
          estimated_revenue?: number | null;
          id?: string;
          provider_name?: string;
          total_clicks?: number | null;
          total_impressions?: number | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      sports: {
        Row: {
          created_at: string | null;
          description: string | null;
          display_name: string | null;
          icon_url: string | null;
          id: string;
          is_active: boolean | null;
          metadata: Json | null;
          name: string;
          parent_sport_id: string | null;
        };
        Insert: {
          created_at?: string | null;
          description?: string | null;
          display_name?: string | null;
          icon_url?: string | null;
          id?: string;
          is_active?: boolean | null;
          metadata?: Json | null;
          name: string;
          parent_sport_id?: string | null;
        };
        Update: {
          created_at?: string | null;
          description?: string | null;
          display_name?: string | null;
          icon_url?: string | null;
          id?: string;
          is_active?: boolean | null;
          metadata?: Json | null;
          name?: string;
          parent_sport_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'sports_parent_sport_id_fkey';
            columns: ['parent_sport_id'];
            isOneToOne: false;
            referencedRelation: 'sports';
            referencedColumns: ['id'];
          },
        ];
      };
      statistics: {
        Row: {
          competition: string | null;
          created_at: string | null;
          id: string;
          is_verified: boolean | null;
          match_id: string | null;
          metrics: Json;
          opponent: string | null;
          profile_variant_id: string;
          sport_id: string | null;
          stat_date: string;
          stat_type: string;
          updated_at: string | null;
        };
        Insert: {
          competition?: string | null;
          created_at?: string | null;
          id?: string;
          is_verified?: boolean | null;
          match_id?: string | null;
          metrics?: Json;
          opponent?: string | null;
          profile_variant_id: string;
          sport_id?: string | null;
          stat_date: string;
          stat_type: string;
          updated_at?: string | null;
        };
        Update: {
          competition?: string | null;
          created_at?: string | null;
          id?: string;
          is_verified?: boolean | null;
          match_id?: string | null;
          metrics?: Json;
          opponent?: string | null;
          profile_variant_id?: string;
          sport_id?: string | null;
          stat_date?: string;
          stat_type?: string;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'statistics_profile_variant_id_fkey';
            columns: ['profile_variant_id'];
            isOneToOne: false;
            referencedRelation: 'profile_variants';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'statistics_sport_id_fkey';
            columns: ['sport_id'];
            isOneToOne: false;
            referencedRelation: 'sports';
            referencedColumns: ['id'];
          },
        ];
      };
      user_preferences: {
        Row: {
          category: Database['public']['Enums']['preference_category'];
          created_at: string | null;
          id: string;
          preferences: Json;
          profile_id: string;
          updated_at: string | null;
        };
        Insert: {
          category: Database['public']['Enums']['preference_category'];
          created_at?: string | null;
          id?: string;
          preferences?: Json;
          profile_id: string;
          updated_at?: string | null;
        };
        Update: {
          category?: Database['public']['Enums']['preference_category'];
          created_at?: string | null;
          id?: string;
          preferences?: Json;
          profile_id?: string;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'user_preferences_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      basketball_experience_level:
        | 'recreational'
        | 'amateur_club'
        | 'school_youth'
        | 'university'
        | 'semi_professional'
        | 'professional_domestic'
        | 'professional_elite'
        | 'former_professional';
      football_experience_level:
        | 'recreational'
        | 'school_team'
        | 'sunday_league'
        | 'club_youth'
        | 'academy'
        | 'amateur_club'
        | 'non_league'
        | 'college_university'
        | 'semi_professional'
        | 'professional'
        | 'former_professional';
      preference_category:
        | 'playscanner'
        | 'notifications'
        | 'privacy'
        | 'display'
        | 'communication'
        | 'discovery'
        | 'analytics';
      profile_variant_type:
        | 'player'
        | 'coach'
        | 'scout'
        | 'agent'
        | 'parent'
        | 'fan'
        | 'referee'
        | 'trainer'
        | 'physio'
        | 'club_admin'
        | 'league_admin';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<
  keyof Database,
  'public'
>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] &
        DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] &
        DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema['Tables']
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema['Tables']
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema['Enums']
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema['CompositeTypes']
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      basketball_experience_level: [
        'recreational',
        'amateur_club',
        'school_youth',
        'university',
        'semi_professional',
        'professional_domestic',
        'professional_elite',
        'former_professional',
      ],
      football_experience_level: [
        'recreational',
        'school_team',
        'sunday_league',
        'club_youth',
        'academy',
        'amateur_club',
        'non_league',
        'college_university',
        'semi_professional',
        'professional',
        'former_professional',
      ],
      preference_category: [
        'playscanner',
        'notifications',
        'privacy',
        'display',
        'communication',
        'discovery',
        'analytics',
      ],
      profile_variant_type: [
        'player',
        'coach',
        'scout',
        'agent',
        'parent',
        'fan',
        'referee',
        'trainer',
        'physio',
        'club_admin',
        'league_admin',
      ],
    },
  },
} as const;
